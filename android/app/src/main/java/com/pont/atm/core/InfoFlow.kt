package com.pont.atm.core

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

sealed interface InfoState {
    data object Idle : InfoState
    data class Sending(val uid: String) : InfoState
    data class Showing(val uid: String, val outcome: InfoOutcome, val at: Long) : InfoState
}

/**
 * The info kiosk's logic: every tap is looked up on the server (nothing is changed there) and its answer
 * shown until the next tap or until [clear]. A tap while a request is in flight is ignored, and so is the same
 * card read again straight away (the NFC chip can report one touch twice). A different card replaces the
 * result at once. Looking a card up is harmless, so there are no idempotency keys and a failed lookup is
 * simply tapped again.
 */
class InfoFlow(
    private val api: InfoApi,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _state = MutableStateFlow<InfoState>(InfoState.Idle)
    val state: StateFlow<InfoState> = _state.asStateFlow()

    private var lastUid: String? = null
    private var lastAt = 0L

    suspend fun onTag(uid: String) {
        val before = _state.value
        if (before is InfoState.Sending) return
        val t = now()
        if (uid == lastUid && t - lastAt < SAME_CARD_GUARD_MS) return
        if (!_state.compareAndSet(before, InfoState.Sending(uid))) return
        lastUid = uid; lastAt = t
        // The Activity that delivered the tag can be recreated mid-request; the answer must still reach the state.
        withContext(NonCancellable) {
            val outcome = try {
                api.infoTap(uid)
            } catch (e: Exception) {
                InfoOutcome.Failed("Something went wrong in the app.")
            }
            _state.value = InfoState.Showing(uid, outcome, now())
        }
    }

    /** Back to "Tap a card". Only from a result; ignored while a request is in flight. */
    fun clear() {
        if (_state.value is InfoState.Showing) _state.value = InfoState.Idle
    }

    companion object {
        const val SAME_CARD_GUARD_MS = 1_500L
    }
}
