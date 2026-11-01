package com.pont.card.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class HomeState(
    val items: List<CardItem> = emptyList(),
    val loading: Boolean = false,
    val notice: Notice? = null,
)

/**
 * What the home and detail screens show. Starts from the copies saved on the phone and then asks the server;
 * the request runs in [scope] (the app's), so turning the phone or leaving a screen doesn't lose the answer.
 */
class CardsModel(private val repo: CardsRepository, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(HomeState(items = repo.saved()))
    val state: StateFlow<HomeState> = _state.asStateFlow()
    private var job: Job? = null

    /** Asks the server again. Ignored while an earlier ask is still running. */
    fun refresh() {
        if (job?.isActive == true) return
        _state.value = _state.value.copy(loading = true)
        job = scope.launch {
            try {
                val r = repo.refresh()
                _state.value = HomeState(r.items, loading = false, notice = r.notice)
            } finally {
                withContext(NonCancellable) { _state.value = _state.value.copy(loading = false) }
            }
        }
    }

    /** A card was just added (see [AddCardFlow]): show it at once. */
    fun reload() {
        _state.value = _state.value.copy(items = repo.saved())
    }

    fun remove(uid: String) {
        repo.remove(uid)
        _state.value = _state.value.copy(items = _state.value.items.filterNot { it.uid == uid })
    }
}
