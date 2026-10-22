package com.pont.atm.core

import kotlinx.serialization.Serializable

@Serializable data class User(val id: String, val name: String, val role: String)

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
