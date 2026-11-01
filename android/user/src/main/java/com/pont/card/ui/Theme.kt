package com.pont.card.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** The warm ink / amber / green family of the terminal app, in a light (cream) and a dark (night ink) version. */
data class Palette(
    val bg: Color, val surface: Color, val ink: Color, val ink2: Color, val ink3: Color, val line: Color,
    val green: Color, val greenSoft: Color, val red: Color, val redSoft: Color, val amber: Color, val amberSoft: Color,
    val onGreen: Color = Color.White, val dark: Boolean,
    /** The colours of the three kinds of points on the program: per time (green), per task (amber ink) and mixed (blue). */
    val amberInk: Color = Color(0xFF6B4A00), val mix: Color = Color(0xFF2B4A63), val mixSoft: Color = Color(0xFFE3ECF3),
)

val LightPalette = Palette(
    bg = Color(0xFFFBF7EF), surface = Color(0xFFFFFFFF), ink = Color(0xFF12202B), ink2 = Color(0xFF4A5B68), ink3 = Color(0xFF6F7F8B),
    line = Color(0xFFE8E1D3), green = Color(0xFF0F7F37), greenSoft = Color(0xFFDDF4E5), red = Color(0xFFC0342C), redSoft = Color(0xFFFBE4E2),
    amber = Color(0xFFF5B31F), amberSoft = Color(0xFFFFF1CF), dark = false,
)

val DarkPalette = Palette(
    bg = Color(0xFF0F1A22), surface = Color(0xFF182630), ink = Color(0xFFF2F5F7), ink2 = Color(0xFFB6C3CC), ink3 = Color(0xFF8A9AA6),
    line = Color(0xFF263541), green = Color(0xFF5BD58A), greenSoft = Color(0xFF16352A), red = Color(0xFFFF8A82), redSoft = Color(0xFF3B2024),
    amber = Color(0xFFF5B31F), amberSoft = Color(0xFF3A2F14), onGreen = Color(0xFF0B2A17), dark = true,
    amberInk = Color(0xFFF5D27A), mix = Color(0xFF9FC1DD), mixSoft = Color(0xFF1F3342),
)

val LocalPalette = staticCompositionLocalOf { LightPalette }

/** The palette of the current theme. */
val palette: Palette @Composable get() = LocalPalette.current

object Type {
    private val family = FontFamily.SansSerif
    fun display(size: Int, weight: FontWeight = FontWeight.ExtraBold) =
        TextStyle(fontFamily = family, fontWeight = weight, fontSize = size.sp, letterSpacing = (-0.02).sp)
}

private val typography = Typography(
    bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 17.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 15.sp, lineHeight = 21.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
)

@Composable
fun PontCardTheme(content: @Composable () -> Unit) {
    val p = if (isSystemInDarkTheme()) DarkPalette else LightPalette
    val scheme = if (p.dark) {
        darkColorScheme(primary = p.green, onPrimary = p.onGreen, background = p.bg, onBackground = p.ink, surface = p.surface, onSurface = p.ink, error = p.red, outline = p.line)
    } else {
        lightColorScheme(primary = p.green, onPrimary = p.onGreen, background = p.bg, onBackground = p.ink, surface = p.surface, onSurface = p.ink, error = p.red, outline = p.line)
    }
    CompositionLocalProvider(LocalPalette provides p) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}
