package com.pont.atm.core

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

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

    /** Begins a charge. Also used by "One more like this" straight from a result. Ignored while a request is in flight. */
    fun start(amount: Int) {
        if (_state.value is FlowState.Sending) return
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
        // The Activity that delivered the tag can be recreated mid-request. The request still reaches the server,
        // so its answer must still reach the state, or the phone would sit on "Sending" while the card is credited.
        withContext(NonCancellable) {
            val outcome = try {
                api.charge(uid, waiting.amount, key!!)
            } catch (e: Exception) {
                ChargeOutcome.Failed("Something went wrong in the app.")
            }
            _state.value = FlowState.Done(waiting.amount, outcome, uid)
        }
    }
}
