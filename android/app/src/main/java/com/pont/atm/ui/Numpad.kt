package com.pont.atm.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** The amount being typed on the keypad: up to four digits, no leading zeros. */
class NumpadState {
    private var digits by mutableStateOf("")

    val amount: Int get() = digits.toIntOrNull() ?: 0
    val display: String get() = digits.ifEmpty { "0" }

    fun press(key: Char) {
        if (key !in '0'..'9' || digits.length >= 4) return
        if (digits.isEmpty() && key == '0') return
        digits += key
    }

    fun backspace() { digits = digits.dropLast(1) }
    fun clear() { digits = "" }
    fun set(value: Int) { digits = if (value in 1..9999) value.toString() else "" }
}
