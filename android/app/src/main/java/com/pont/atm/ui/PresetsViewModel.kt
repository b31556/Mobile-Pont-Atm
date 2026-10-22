package com.pont.atm.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.pont.atm.core.PresetsApi

/** Presets and the "tap once, then card" switch. Every change is saved to the server; a failed save changes nothing. */
class PresetsViewModel(private val api: PresetsApi) {
    var values by mutableStateOf(listOf(4, 8, 12, 20)); private set
    var instant by mutableStateOf(true); private set
    var message by mutableStateOf<String?>(null)

    suspend fun load(): Result<Unit> =
        api.presets().onSuccess { values = it.values; instant = it.instantPreset }.onFailure { message = it.message }.map { }

    suspend fun add(text: String): Boolean {
        val v = text.trim().toIntOrNull()
        return when {
            v == null || v !in 1..9999 -> refuse("Enter a whole number from 1 to 9999.")
            v in values -> refuse("That preset already exists.")
            values.size >= 8 -> refuse("Up to 8 presets.")
            else -> save(values + v, instant)
        }
    }

    suspend fun remove(value: Int) = save(values - value, instant)
    suspend fun setInstant(on: Boolean) = save(values, on)

    private fun refuse(msg: String): Boolean { message = msg; return false }

    private suspend fun save(newValues: List<Int>, newInstant: Boolean): Boolean =
        api.savePresets(newValues.sorted(), newInstant)
            .onSuccess { values = it.values; instant = it.instantPreset }
            .onFailure { message = it.message }
            .isSuccess
}
