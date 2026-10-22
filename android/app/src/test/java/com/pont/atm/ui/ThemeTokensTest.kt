package com.pont.atm.ui

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test

class ThemeTokensTest {
    @Test fun brandColorsMatchTheSketch() {
        assertEquals(Color(0xFF17A34A), PontColors.Green)
        assertEquals(Color(0xFF12202B), PontColors.Ink)
        assertEquals(Color(0xFFF5B31F), PontColors.Amber)
        assertEquals(Color(0xFFD23B33), PontColors.Red)
        assertEquals(Color(0xFFEEF1F3), PontColors.Bg)
    }
}
