package com.pont.card.core

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

sealed interface AddState {
    /** Waiting for a card to be held to the phone. */
    data object Waiting : AddState
    data class Checking(val uid: String) : AddState
    /** The card is registered and now saved on the phone. [isNew] is false if it was saved already. */
    data class Added(val uid: String, val name: String, val isNew: Boolean) : AddState
    data object NotRegistered : AddState
    data object Full : AddState
    /** The tag has a UID this app can't use (not 4, 7 or 10 bytes). */
    data object Unsupported : AddState
    data class Error(val message: String, val offline: Boolean) : AddState
}

/** "Add a card": each tap is asked about on the server; a registered card is saved, the rest explained. */
class AddCardFlow(private val repo: CardsRepository) {
    private val _state = MutableStateFlow<AddState>(AddState.Waiting)
    val state: StateFlow<AddState> = _state.asStateFlow()

    /** Back to waiting, e.g. when the screen opens or after the user dismissed a message. */
    fun reset() { if (_state.value !is AddState.Checking) _state.value = AddState.Waiting }

    /** [id] is `Tag.getId()`. A tap while a lookup is running, or after a card was added, is ignored. */
    suspend fun onTagId(id: ByteArray) {
        val before = _state.value
        if (before is AddState.Checking || before is AddState.Added) return
        val uid = formatUid(id)
        if (uid == null) { _state.value = AddState.Unsupported; return }
        if (!_state.compareAndSet(before, AddState.Checking(uid))) return
        // The screen that delivered the tag can be recreated mid-request; the answer must still reach the state.
        withContext(NonCancellable) {
            _state.value = try {
                when (val r = repo.lookup(uid)) {
                    is LookupResult.Saved -> AddState.Added(r.uid, r.card.name, r.isNew)
                    LookupResult.NotRegistered -> AddState.NotRegistered
                    LookupResult.Full -> AddState.Full
                    is LookupResult.Failed -> AddState.Error(r.message, r.offline)
                }
            } catch (e: Exception) {
                AddState.Error("Something went wrong in the app.", offline = false)
            }
        }
    }
}
