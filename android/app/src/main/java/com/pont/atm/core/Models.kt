package com.pont.atm.core

import kotlinx.serialization.Serializable

@Serializable data class TxInfo(val id: Long, val amount: Int, val createdAt: String, val terminal: String)

@Serializable data class CardInfo(
    val id: String, val name: String, val photoUrl: String,
    val balanceBefore: Int, val balance: Int,
)

@Serializable data class CardRef(val id: String, val name: String, val photoUrl: String)

/** One row of GET /transactions. `type` is "give" or "storno"; `status` is "ok" or "stornoed". */
@Serializable data class Tx(
    val id: Long, val type: String, val amount: Int, val status: String, val ref: Long? = null,
    val createdAt: String, val terminal: String, val operator: String, val card: CardRef,
)

@Serializable data class StornoResult(val transaction: TxInfo, val card: CardInfo)

@Serializable data class PresetConfig(val values: List<Int>, val instantPreset: Boolean)

sealed interface ChargeOutcome {
    data class Success(val tx: TxInfo, val card: CardInfo) : ChargeOutcome
    data class Blocked(val name: String, val photoUrl: String) : ChargeOutcome
    data object UnknownCard : ChargeOutcome
    data object NoConnection : ChargeOutcome
    data class Failed(val message: String) : ChargeOutcome
}

/** A refusal or failure reported by the server, carrying its message for display. */
class ApiException(message: String, val code: String? = null, val status: Int = 0) : Exception(message)

interface HistoryApi {
    suspend fun history(): Result<List<Tx>>
    suspend fun storno(id: Long): Result<StornoResult>
}

interface PresetsApi {
    suspend fun presets(): Result<PresetConfig>
    suspend fun savePresets(values: List<Int>, instantPreset: Boolean): Result<PresetConfig>
}

// ---- check-in mode ----

@Serializable data class TerminalConfig(val mode: String, val name: String)

@Serializable data class PresenceCard(val id: String, val name: String, val photoUrl: String, val balance: Int)

/** Points earned from presence in the last 24 h, and the limit if there is one. */
@Serializable data class PresenceToday(val earned: Int, val max: Int? = null)

/**
 * What a check-in tap did. [action] is `in`, `out`, `cooldown` (tapped again too soon, nothing changed)
 * or `expired_in` (the last visit was never signed out, earned nothing, and a new one started).
 */
@Serializable data class PresenceResult(
    val action: String, val card: PresenceCard, val inAt: String, val outAt: String? = null, val minutes: Int? = null,
    val points: Int = 0, val raw: Int = 0, val cappedBy: String? = null, val today: PresenceToday, val expiredMinutes: Int? = null,
)

sealed interface PresenceOutcome {
    data class Done(val result: PresenceResult) : PresenceOutcome
    data class Blocked(val name: String, val photoUrl: String) : PresenceOutcome
    data object UnknownCard : PresenceOutcome
    data object NoConnection : PresenceOutcome
    data object WrongMode : PresenceOutcome
    data class Failed(val message: String) : PresenceOutcome
}

fun interface PresenceApi {
    suspend fun presenceTap(uid: String, key: String): PresenceOutcome
}
