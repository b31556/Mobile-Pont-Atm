package com.pont.atm.core

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

sealed interface PresenceState {
    data object Idle : PresenceState
    data class Sending(val uid: String) : PresenceState
    data class Showing(val uid: String, val outcome: PresenceOutcome, val at: Long) : PresenceState
}

/**
 * The button-less check-in screen's logic: every tap is sent to the server and its answer shown until the
 * next tap or until [clear]. A tap while a request is in flight is ignored, and so is the same card read
 * again straight away (the NFC chip can report one touch twice).
 *
 * After a lost connection or a server failure the server may or may not have signed the card in or out, so
 * tapping the same card again within a minute re-uses the key and the server answers once.
 */
class PresenceFlow(
    private val api: PresenceApi,
    private val newKey: () -> String,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _state = MutableStateFlow<PresenceState>(PresenceState.Idle)
    val state: StateFlow<PresenceState> = _state.asStateFlow()

    private var lastUid: String? = null
    private var lastAt = 0L
    private var retryKey: String? = null
    private var retryUid: String? = null
    private var retryAt = 0L

    suspend fun onTag(uid: String) {
        val before = _state.value
        if (before is PresenceState.Sending) return
        val t = now()
        if (uid == lastUid && t - lastAt < SAME_CARD_GUARD_MS) return
        if (!_state.compareAndSet(before, PresenceState.Sending(uid))) return
        lastUid = uid; lastAt = t
        val key = if (retryKey != null && retryUid == uid && t - retryAt < RETRY_WINDOW_MS) retryKey!! else newKey()
        // The Activity that delivered the tag can be recreated mid-request; the answer must still reach the state.
        withContext(NonCancellable) {
            val outcome = try {
                api.presenceTap(uid, key)
            } catch (e: Exception) {
                PresenceOutcome.Failed("Something went wrong in the app.")
            }
            if (outcome is PresenceOutcome.NoConnection || outcome is PresenceOutcome.Failed) {
                retryKey = key; retryUid = uid; retryAt = t
            } else retryKey = null
            _state.value = PresenceState.Showing(uid, outcome, now())
        }
    }

    /** Back to "Tap your card". Only from a result; ignored while a request is in flight. */
    fun clear() {
        if (_state.value is PresenceState.Showing) _state.value = PresenceState.Idle
    }

    private companion object {
        const val SAME_CARD_GUARD_MS = 3_000L
        const val RETRY_WINDOW_MS = 60_000L
    }
}
