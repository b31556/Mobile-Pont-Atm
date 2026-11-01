package com.pont.atm.core

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/** Which visit and which end of it: `in` cancels the check-in, `out` the check-out. */
data class CancelKey(val sessionId: Long, val expect: String)

sealed interface CancelState {
    data object Idle : CancelState
    /** The confirmation sheet is open. */
    data class Asking(val key: CancelKey) : CancelState
    /** The request is in flight: nothing more can be started. */
    data class Sending(val key: CancelKey) : CancelState
    data class Done(val key: CancelKey, val result: CancelResult) : CancelState
    /** The server refused, or could not be reached; the buttons stay so it can be tried again. */
    data class Failed(val key: CancelKey, val message: String) : CancelState

    val keyOrNull: CancelKey?
        get() = when (this) { Idle -> null; is Asking -> key; is Sending -> key; is Done -> key; is Failed -> key }
}

/**
 * "Cancel this check-in / check-out" on the check-in result screen. The state belongs to one [CancelKey], so a
 * result for another visit never shows it. [confirm] only runs from [CancelState.Asking] and moves to
 * [CancelState.Sending] before anything is sent, so a double tap sends one request. Once a cancel went through
 * it can't be started again.
 */
class CancelFlow(private val api: PresenceCancelApi) {
    private val _state = MutableStateFlow<CancelState>(CancelState.Idle)
    val state: StateFlow<CancelState> = _state.asStateFlow()

    /** Opens the confirmation. Ignored while sending, or after this visit was cancelled. */
    fun ask(key: CancelKey) {
        val before = _state.value
        if (before is CancelState.Sending) return
        if (before is CancelState.Done && before.key == key) return
        _state.compareAndSet(before, CancelState.Asking(key))
    }

    /** "Keep": closes the confirmation. */
    fun dismiss() {
        val before = _state.value
        if (before is CancelState.Asking) _state.compareAndSet(before, CancelState.Idle)
    }

    suspend fun confirm(key: CancelKey) {
        val before = _state.value
        if (before != CancelState.Asking(key)) return
        if (!_state.compareAndSet(before, CancelState.Sending(key))) return
        // The screen can be recreated mid-request; the answer must still reach the state.
        withContext(NonCancellable) {
            val outcome = try {
                api.cancelSession(key.sessionId, key.expect)
            } catch (e: Exception) {
                CancelOutcome.Failed("Something went wrong in the app.")
            }
            _state.value = when (outcome) {
                is CancelOutcome.Done -> CancelState.Done(key, outcome.result)
                is CancelOutcome.Failed -> CancelState.Failed(key, outcome.message)
                CancelOutcome.NoConnection -> CancelState.Failed(key, "No connection. The cancel may not have gone through. Try again.")
            }
        }
    }

    /** Forgets everything, e.g. when the phone changes mode. Not while a request is in flight. */
    fun reset() {
        if (_state.value !is CancelState.Sending) _state.value = CancelState.Idle
    }
}
