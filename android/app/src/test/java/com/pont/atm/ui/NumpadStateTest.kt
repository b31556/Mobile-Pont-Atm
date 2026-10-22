package com.pont.atm.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class NumpadStateTest {
    private fun pad(vararg keys: Char) = NumpadState().also { p -> keys.forEach(p::press) }

    @Test fun digitsBuildTheAmount() = assertEquals(12, pad('1', '2').amount)
    @Test fun aLeadingZeroIsIgnored() = assertEquals(5, pad('0', '5').amount)
    @Test fun zeroAloneIsZero() = assertEquals(0, pad('0', '0').amount)
    @Test fun inputStopsAtFourDigits() = assertEquals(1234, pad('1', '2', '3', '4', '5').amount)
    @Test fun zerosAfterADigitCount() = assertEquals(100, pad('1', '0', '0').amount)
    @Test fun backspaceOnOneDigitGivesZero() { val p = pad('7'); p.backspace(); assertEquals(0, p.amount) }
    @Test fun backspaceRemovesTheLastDigit() { val p = pad('1', '2'); p.backspace(); assertEquals(1, p.amount) }
    @Test fun clearGivesZero() { val p = pad('1', '2'); p.clear(); assertEquals(0, p.amount) }
    @Test fun displayShowsZeroWhenEmpty() = assertEquals("0", NumpadState().display)
    @Test fun nonDigitsAreIgnored() = assertEquals(3, pad('3', 'x', '-').amount)
    @Test fun setFillsTheAmountFromAPreset() { val p = NumpadState(); p.set(20); assertEquals(20, p.amount) }
}
