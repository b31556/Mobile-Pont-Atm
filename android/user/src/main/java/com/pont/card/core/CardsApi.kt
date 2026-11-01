package com.pont.card.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** What asking the server about some cards came to. */
sealed interface FetchResult {
    data class Ok(val cards: List<PublicCard>) : FetchResult
    /** HTTP 429. */
    data object TooManyTries : FetchResult
    /** Any other HTTP refusal or failure; [message] is the server's own words when it sent some. */
    data class ServerError(val status: Int, val message: String) : FetchResult
    /** The server could not be reached. */
    data object Offline : FetchResult
    /** The server answered 200 with something that isn't the expected JSON. */
    data object Unreadable : FetchResult
}

/** What the user is told for a failed request. [Ok] has no message. */
fun FetchResult.userMessage(): String? = when (this) {
    is FetchResult.Ok -> null
    FetchResult.TooManyTries -> "Too many tries, wait a few minutes"
    is FetchResult.ServerError -> message
    FetchResult.Offline -> "Can't reach the server."
    FetchResult.Unreadable -> "The server sent an answer the app can't read."
}

fun interface CardsFetcher {
    suspend fun fetch(uids: List<String>): FetchResult
}

/** Talks to the public, read-only endpoint of the Pont server. No account and no token. All calls are main-safe. */
class CardsApi(
    private val baseUrl: String,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).writeTimeout(10, TimeUnit.SECONDS).build(),
) : CardsFetcher {

    override suspend fun fetch(uids: List<String>): FetchResult = withContext(Dispatchers.IO) {
        try {
            if (baseUrl.isBlank()) throw IOException("No server address")
            val body = PontJson.encodeToString(CardsRequest.serializer(), CardsRequest(uids))
            val req = Request.Builder().url(baseUrl.trimEnd('/') + "/public/cards")
                .post(body.toRequestBody("application/json".toMediaType())).build()
            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                when {
                    resp.code == 429 -> FetchResult.TooManyTries
                    resp.code in 200..299 ->
                        runCatching { FetchResult.Ok(PontJson.decodeFromString(CardsResponse.serializer(), text).cards) }
                            .getOrDefault(FetchResult.Unreadable)
                    else -> FetchResult.ServerError(resp.code, errorMessage(text, resp.code))
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            FetchResult.Offline
        } catch (e: Exception) {
            FetchResult.ServerError(0, "Something went wrong in the app.")
        }
    }

    private fun errorMessage(body: String, status: Int): String =
        runCatching { PontJson.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.contentOrNull }.getOrNull()
            ?.takeIf { it.isNotBlank() } ?: "Something went wrong ($status)."
}
