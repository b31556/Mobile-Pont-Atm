package com.pont.atm.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** Colors taken from the approved sketch (sketch/index.html :root tokens). */
object PontColors {
    val Ink = Color(0xFF12202B)
    val Ink2 = Color(0xFF4A5B68)
    val Ink3 = Color(0xFF7C8B96)
    val Line = Color(0xFFD5DCE1)
    val Bg = Color(0xFFEEF1F3)
    val Paper = Color(0xFFFFFFFF)
    val Green = Color(0xFF17A34A)
    val GreenDark = Color(0xFF0F7F37)
    val GreenLight = Color(0xFF5BD58A)
    val Amber = Color(0xFFF5B31F)
    val AmberLight = Color(0xFFFFF1CF)
    val Red = Color(0xFFD23B33)
    val RedLight = Color(0xFFFBE4E2)
}

/** The sketch uses Bricolage Grotesque / Figtree; v1 uses the system sans with the same weights. */
object PontType {
    val Display = FontFamily.SansSerif
    val Text = FontFamily.SansSerif
    fun display(size: Int, weight: FontWeight = FontWeight.ExtraBold) =
        TextStyle(fontFamily = Display, fontWeight = weight, fontSize = size.sp, letterSpacing = (-0.02).sp)
}

private val pontColorScheme = lightColorScheme(
    primary = PontColors.Green, onPrimary = Color.White,
    secondary = PontColors.Amber, onSecondary = PontColors.Ink,
    background = PontColors.Bg, onBackground = PontColors.Ink,
    surface = PontColors.Paper, onSurface = PontColors.Ink,
    error = PontColors.Red, onError = Color.White,
    outline = PontColors.Line,
)

private val pontTypography = Typography(
    bodyLarge = TextStyle(fontFamily = PontType.Text, fontSize = 16.sp),
    bodyMedium = TextStyle(fontFamily = PontType.Text, fontSize = 14.sp),
    labelLarge = TextStyle(fontFamily = PontType.Text, fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
)

@Composable
fun PontTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = pontColorScheme, typography = pontTypography, content = content)
}
