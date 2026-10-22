package com.pont.atm.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

fun interface ChargeApi {
    suspend fun charge(uid: String, amount: Int, key: String): ChargeOutcome
}

sealed interface FlowState {
    data object Idle : FlowState
    data class WaitingForCard(val amount: Int) : FlowState
    data class Sending(val amount: Int, val uid: String) : FlowState
    data class Done(val amount: Int, val outcome: ChargeOutcome, val uid: String) : FlowState
}

/**
 * One charge from "operator picked an amount" to "server answered".
 *
 * Idempotency: a key identifies one intended charge. After a lost connection or a server failure the
 * server may or may not have credited the card, so [retry] keeps the key and the server replays the
 * original result instead of crediting twice. Any definite answer, or a different card, starts a new key.
 */
class ChargeFlow(private val api: ChargeApi, private val newKey: () -> String) {
    private val _state = MutableStateFlow<FlowState>(FlowState.Idle)
    val state: StateFlow<FlowState> = _state.asStateFlow()

    private var key: String? = null
    private var keyUid: String? = null

    fun start(amount: Int) {
        key = newKey(); keyUid = null
        _state.value = FlowState.WaitingForCard(amount)
    }

    fun cancel() {
        if (_state.value is FlowState.WaitingForCard) _state.value = FlowState.Idle
    }

    fun reset() {
        if (_state.value !is FlowState.Sending) _state.value = FlowState.Idle
    }

    fun retry() {
        val done = _state.value as? FlowState.Done ?: return
        val keep = done.outcome is ChargeOutcome.NoConnection || done.outcome is ChargeOutcome.Failed
        if (!keep) { key = newKey(); keyUid = null }
        _state.value = FlowState.WaitingForCard(done.amount)
    }

    suspend fun onTag(uid: String) {
        val waiting = _state.value as? FlowState.WaitingForCard ?: return
        if (!_state.compareAndSet(waiting, FlowState.Sending(waiting.amount, uid))) return
        if (keyUid != null && keyUid != uid) key = newKey()
        keyUid = uid
        val outcome = api.charge(uid, waiting.amount, key!!)
        _state.value = FlowState.Done(waiting.amount, outcome, uid)
    }
}
