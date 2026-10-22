package com.pont.atm.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.pont.atm.core.HistoryApi
import com.pont.atm.core.Tx

/** Today's charges for this terminal, with the storno confirmation flow. Plain class so it tests without Android. */
class HistoryViewModel(private val api: HistoryApi) {
    var rows by mutableStateOf<List<Tx>>(emptyList()); private set
    var loading by mutableStateOf(false); private set
    var target by mutableStateOf<Tx?>(null); private set
    var confirming by mutableStateOf(false); private set
    var message by mutableStateOf<String?>(null)

    suspend fun load(): Result<Unit> {
        loading = true
        val r = api.history()
        loading = false
        r.onSuccess { list -> rows = list.filter { it.type == "give" } }.onFailure { message = it.message }
        return r.map { }
    }

    fun open(id: Long) { target = rows.firstOrNull { it.id == id }; confirming = false }
    fun askStorno() { if (target != null) confirming = true }
    fun dismiss() { target = null; confirming = false }

    suspend fun confirmStorno() {
        val tx = target ?: return
        api.storno(tx.id)
            .onSuccess { r ->
                rows = rows.map { if (it.id == tx.id) it.copy(status = "stornoed") else it }
                message = "Stornoed. ${r.card.name} now has ${r.card.balance} points."
            }
            .onFailure { message = it.message }
        dismiss()
    }
}
