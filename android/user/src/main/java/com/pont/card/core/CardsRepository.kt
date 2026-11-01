package com.pont.card.core

/** How much a row on the home screen can be trusted. */
enum class ItemState {
    /** Just answered by the server. */
    Fresh,
    /** The server's last answer, kept on the phone. */
    Saved,
    /** The server says this card is no longer registered. */
    NotRegistered,
    /** Nothing known yet: the server could not be reached and nothing was saved. */
    Unavailable,
}

data class CardItem(val uid: String, val card: PublicCard?, val state: ItemState)

/** Something worth telling the user next to the cards. */
sealed interface Notice {
    /** The server could not be reached, the cards shown are the saved copies. */
    data object Offline : Notice
    /** The server refused or failed; [message] is ready to show. */
    data class Problem(val message: String) : Notice
}

data class RefreshResult(val items: List<CardItem>, val notice: Notice?)

sealed interface LookupResult {
    data class Saved(val uid: String, val card: PublicCard, val isNew: Boolean) : LookupResult
    data object NotRegistered : LookupResult
    /** The phone already holds [UidStore.MAX_CARDS] cards. */
    data object Full : LookupResult
    data class Failed(val message: String, val offline: Boolean) : LookupResult
}

/** Puts the saved UIDs, the saved copies and the server together. */
class CardsRepository(
    private val store: UidStore,
    private val cache: SnapshotCache,
    private val fetcher: CardsFetcher,
) {
    /** The cards on this phone as last seen, without asking the server. */
    fun saved(): List<CardItem> = store.list().map { fromCache(it) }

    private fun fromCache(uid: String): CardItem =
        cache.get(uid)?.let { CardItem(uid, it, ItemState.Saved) } ?: CardItem(uid, null, ItemState.Unavailable)

    /** Asks the server about every saved card. On a failure the saved copies are returned with a [Notice]. */
    suspend fun refresh(): RefreshResult {
        val uids = store.list()
        if (uids.isEmpty()) return RefreshResult(emptyList(), null)
        return when (val r = fetcher.fetch(uids)) {
            is FetchResult.Ok -> {
                val byUid = r.cards.mapNotNull { c -> normalizeUid(c.uid)?.let { it to c } }.toMap()
                RefreshResult(uids.map { uid ->
                    val c = byUid[uid]
                    when {
                        c == null -> fromCache(uid)
                        c.found -> { cache.put(uid, c); CardItem(uid, c.copy(uid = uid), ItemState.Fresh) }
                        else -> { cache.remove(uid); CardItem(uid, null, ItemState.NotRegistered) }
                    }
                }, null)
            }
            FetchResult.Offline -> RefreshResult(saved(), Notice.Offline)
            else -> RefreshResult(saved(), Notice.Problem(r.userMessage().orEmpty()))
        }
    }

    /** Asks the server about one card just tapped, and keeps it on the phone if it is registered. */
    suspend fun lookup(uid: String): LookupResult {
        val canonical = normalizeUid(uid) ?: return LookupResult.NotRegistered
        val already = store.contains(canonical)
        if (!already && store.list().size >= UidStore.MAX_CARDS) return LookupResult.Full
        return when (val r = fetcher.fetch(listOf(canonical))) {
            is FetchResult.Ok -> {
                val card = r.cards.firstOrNull { normalizeUid(it.uid) == canonical } ?: r.cards.singleOrNull()
                if (card == null || !card.found) {
                    LookupResult.NotRegistered
                } else {
                    store.add(canonical)
                    cache.put(canonical, card)
                    LookupResult.Saved(canonical, card.copy(uid = canonical), isNew = !already)
                }
            }
            FetchResult.Offline -> LookupResult.Failed(r.userMessage().orEmpty(), offline = true)
            else -> LookupResult.Failed(r.userMessage().orEmpty(), offline = false)
        }
    }

    fun remove(uid: String) {
        store.remove(uid)
        normalizeUid(uid)?.let { cache.remove(it) }
    }
}
