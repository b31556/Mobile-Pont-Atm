package com.pont.atm.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Talks to the Pont server. All calls are main-safe. */
class PontApi(
    private val session: SessionStore,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).writeTimeout(10, TimeUnit.SECONDS).build(),
) : HistoryApi, PresetsApi {
    private val json = Json { ignoreUnknownKeys = true }
    private class Raw(val status: Int, val body: String)

    fun photoUrl(path: String) = session.baseUrl.trimEnd('/') + path

    private suspend fun raw(method: String, path: String, body: JsonObject? = null, authorized: Boolean = true): Raw = withContext(Dispatchers.IO) {
        if (session.baseUrl.isBlank()) throw IOException("No server address")
        val req = Request.Builder().url(photoUrl(path))
            .method(method, if (body == null && method == "GET") null else (body?.toString() ?: "{}").toRequestBody("application/json".toMediaType()))
        if (authorized) session.terminalToken?.let { req.header("Authorization", "Bearer $it") }
        client.newCall(req.build()).execute().use { Raw(it.code, it.body?.string().orEmpty()) }
    }

    private fun errorOf(r: Raw): ApiException {
        val obj = runCatching { json.parseToJsonElement(r.body).jsonObject }.getOrNull()
        val message = obj?.get("error")?.jsonPrimitive?.contentOrNull ?: "Something went wrong (${r.status})."
        return ApiException(message, obj?.get("code")?.jsonPrimitive?.contentOrNull, r.status)
    }

    private suspend fun <T> call(method: String, path: String, body: JsonObject? = null, authorized: Boolean = true, parse: (String) -> T): Result<T> =
        try {
            val r = raw(method, path, body, authorized)
            if (r.status == 401 && authorized) unpair() // the server no longer accepts this phone (revoked)
            if (r.status in 200..299) Result.success(parse(r.body)) else Result.failure(errorOf(r))
        } catch (e: IOException) {
            Result.failure(ApiException("No connection to the server.", "no_connection"))
        }

    suspend fun pair(code: String, device: String, appVersion: String): Result<Unit> =
        call("POST", "/pair", buildJsonObject { put("code", code); put("device", device); put("appVersion", appVersion) }, authorized = false) { body ->
            val o = json.parseToJsonElement(body).jsonObject
            session.terminalToken = o["terminalToken"]!!.jsonPrimitive.content
            session.terminalName = o["terminal"]!!.jsonObject["name"]!!.jsonPrimitive.content
        }

    suspend fun charge(cardUid: String, amount: Int, idempotencyKey: String): ChargeOutcome {
        val body = buildJsonObject { put("cardUid", cardUid); put("amount", amount); put("idempotencyKey", idempotencyKey) }
        val r = try { raw("POST", "/charges", body) } catch (e: IOException) { return ChargeOutcome.NoConnection }
        if (r.status == 401) unpair()
        val obj = runCatching { json.parseToJsonElement(r.body).jsonObject }.getOrNull()
        val code = obj?.get("code")?.jsonPrimitive?.contentOrNull
        return when {
            r.status == 200 -> runCatching {
                ChargeOutcome.Success(
                    json.decodeFromJsonElement(TxInfo.serializer(), obj!!["transaction"]!!),
                    json.decodeFromJsonElement(CardInfo.serializer(), obj["card"]!!),
                )
            }.getOrElse { ChargeOutcome.Failed("The server sent an answer the app can't read.") }
            r.status == 404 && code == "unknown_card" -> ChargeOutcome.UnknownCard
            r.status == 403 && code == "card_blocked" -> {
                val card = obj!!["card"]?.jsonObject
                ChargeOutcome.Blocked(card?.get("name")?.jsonPrimitive?.contentOrNull.orEmpty(), card?.get("photoUrl")?.jsonPrimitive?.contentOrNull.orEmpty())
            }
            else -> ChargeOutcome.Failed(errorOf(r).message ?: "Something went wrong.")
        }
    }

    /** Asks an admin to register a card the terminal didn't recognise. */
    suspend fun suggestCard(cardUid: String): Result<Unit> =
        call("POST", "/card-suggestions", buildJsonObject { put("cardUid", cardUid) }) { }

    override suspend fun history(): Result<List<Tx>> =
        call("GET", "/transactions?limit=100") { json.decodeFromString<List<Tx>>(it) }

    override suspend fun storno(id: Long): Result<StornoResult> =
        call("POST", "/transactions/$id/storno") { json.decodeFromString<StornoResult>(it) }

    override suspend fun presets(): Result<PresetConfig> = call("GET", "/presets") { json.decodeFromString<PresetConfig>(it) }

    override suspend fun savePresets(values: List<Int>, instantPreset: Boolean): Result<PresetConfig> =
        call("PUT", "/presets", buildJsonObject {
            putJsonArray("values") { values.forEach { add(JsonPrimitive(it)) } }
            put("instantPreset", instantPreset)
        }) { json.decodeFromString<PresetConfig>(it) }

    /** Photo bytes for a holder, fetched with the phone's token (photos are not public). */
    suspend fun photoBytes(path: String): ByteArray? = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url(photoUrl(path)).apply { session.terminalToken?.let { header("Authorization", "Bearer $it") } }.build()
            client.newCall(req).execute().use { if (it.isSuccessful) it.body?.bytes() else null }
        } catch (e: IOException) { null }
    }

    /** Forget this phone's pairing. An admin has to create a new pairing code to use it again. */
    fun unpair() { session.terminalToken = null; session.terminalName = null }
}
