package com.pont.card.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

/** What asking the server for the program came to. */
sealed interface ProgramFetch {
    data class Ok(val doc: ProgramDoc) : ProgramFetch
    data object Offline : ProgramFetch
    data class Failed(val message: String) : ProgramFetch
}

fun interface ProgramFetcher { suspend fun fetch(): ProgramFetch }

/** Reads the public program of the Pont server. No account and no token. Main-safe. */
class ProgramApi(
    private val baseUrl: String,
    private val client: OkHttpClient = OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).build(),
) : ProgramFetcher {
    override suspend fun fetch(): ProgramFetch = withContext(Dispatchers.IO) {
        try {
            if (baseUrl.isBlank()) throw IOException("No server address")
            client.newCall(Request.Builder().url(baseUrl.trimEnd('/') + "/public/program").build()).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                when {
                    resp.code == 429 -> ProgramFetch.Failed("Too many tries, wait a few minutes")
                    resp.code !in 200..299 -> ProgramFetch.Failed("Something went wrong (${resp.code}).")
                    else -> runCatching { ProgramFetch.Ok(PontJson.decodeFromString(ProgramDoc.serializer(), text)) }
                        .getOrDefault(ProgramFetch.Failed("The server sent a program the app can't read."))
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            ProgramFetch.Offline
        } catch (e: Exception) {
            ProgramFetch.Failed("Something went wrong in the app.")
        }
    }
}

/** The program as last received, kept on the phone so the screen works offline. */
class ProgramRepository(private val kv: KeyValueStore, private val fetcher: ProgramFetcher) {
    fun cached(): ProgramDoc? =
        kv.get(KEY)?.let { runCatching { PontJson.decodeFromString(ProgramDoc.serializer(), it) }.getOrNull() }?.takeIf { it.events.isNotEmpty() }

    suspend fun refresh(): ProgramFetch = fetcher.fetch().also {
        if (it is ProgramFetch.Ok && it.doc.events.isNotEmpty()) kv.put(KEY, PontJson.encodeToString(ProgramDoc.serializer(), it.doc))
    }

    private companion object { const val KEY = "program" }
}

@Serializable data class PlanData(val likes: List<String> = emptyList(), val placed: Map<String, PlacedDto> = emptyMap(), val skipped: List<String> = emptyList())
@Serializable data class PlacedDto(val start: Int, val dur: Int)

/** What the person liked and planned, kept on the phone. */
class PlanStore(private val kv: KeyValueStore) {
    fun load(): PlanData = kv.get(KEY)?.let { runCatching { PontJson.decodeFromString(PlanData.serializer(), it) }.getOrNull() } ?: PlanData()
    fun save(data: PlanData) { kv.put(KEY, PontJson.encodeToString(PlanData.serializer(), data)) }

    private companion object { const val KEY = "plan" }
}

data class ProgramState(
    val doc: ProgramDoc? = null,
    val loading: Boolean = false,
    /** The server could not be reached, so [doc] is the saved copy (or missing). */
    val offline: Boolean = false,
    val problem: String? = null,
    val likes: Set<String> = emptySet(),
    val placed: Map<String, Placement> = emptyMap(),
    /** Events the person does not want: they are left out of the cards on Plan until brought back. */
    val skipped: Set<String> = emptySet(),
) {
    fun event(id: String): ProgramEvent? = doc?.events?.firstOrNull { it.id == id }
    fun eventsOn(day: String): List<ProgramEvent> = doc?.events.orEmpty().filter { it.day == day }
    /** The stays planned on [day], earliest first. */
    fun placedOn(day: String): List<Placed> =
        placed.mapNotNull { (id, at) -> event(id)?.takeIf { it.day == day }?.let { Placed(it, at) } }.sortedBy { it.at.start }
    fun plannedPoints(day: String? = null): Int =
        placed.entries.sumOf { (id, at) -> event(id)?.takeIf { day == null || it.day == day }?.let { ProgramMath.earn(it, at.dur) } ?: 0 }
}

/** The program screen's state. Starts from the saved copy, asks the server in the app's scope, and saves likes and plans at once. */
class ProgramModel(private val repo: ProgramRepository, private val store: PlanStore, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(initial())
    val state: StateFlow<ProgramState> = _state.asStateFlow()
    private var job: Job? = null

    private fun initial(): ProgramState {
        val data = store.load()
        val doc = repo.cached()
        return pruned(ProgramState(doc = doc, likes = data.likes.toSet(), placed = data.placed.mapValues { Placement(it.value.start, it.value.dur) }, skipped = data.skipped.toSet()))
    }

    /** Likes and plans of events the program no longer has are dropped. */
    private fun pruned(s: ProgramState): ProgramState {
        val doc = s.doc ?: return s
        val ids = doc.events.map { it.id }.toSet()
        return s.copy(likes = s.likes.filter { it in ids }.toSet(), placed = s.placed.filterKeys { it in ids }, skipped = s.skipped.filter { it in ids }.toSet())
    }

    fun refresh() {
        if (job?.isActive == true) return
        _state.value = _state.value.copy(loading = true)
        job = scope.launch {
            try {
                when (val r = repo.refresh()) {
                    is ProgramFetch.Ok -> _state.value = pruned(_state.value.copy(doc = r.doc, offline = false, problem = null)).also { persist(it) }
                    ProgramFetch.Offline -> _state.value = _state.value.copy(offline = true, problem = null)
                    is ProgramFetch.Failed -> _state.value = _state.value.copy(problem = r.message)
                }
            } finally {
                _state.value = _state.value.copy(loading = false)
            }
        }
    }

    fun toggleLike(id: String) = update { it.copy(likes = if (id in it.likes) it.likes - id else it.likes + id) }

    fun place(id: String, at: Placement) = update { it.copy(placed = it.placed + (id to at)) }

    fun remove(id: String) = update { it.copy(placed = it.placed - id) }

    /** "Not for me": the event stops coming up as a card on Plan. */
    fun skip(id: String) = update { it.copy(skipped = it.skipped + id) }

    /** Brings back every skipped event. */
    fun unskipAll() = update { it.copy(skipped = emptySet()) }

    private fun update(change: (ProgramState) -> ProgramState) {
        _state.value = change(_state.value).also { persist(it) }
    }

    private fun persist(s: ProgramState) = store.save(PlanData(s.likes.toList(), s.placed.mapValues { PlacedDto(it.value.start, it.value.dur) }, s.skipped.toList()))
}
