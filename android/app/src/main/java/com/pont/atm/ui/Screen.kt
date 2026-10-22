package com.pont.atm.ui

sealed interface Screen {
    data object Pair : Screen
    data object Charge : Screen
    data object Tap : Screen
    data object Processing : Screen
    data object Result : Screen
    data object History : Screen
    data object Presets : Screen
}

/** Screens that show the bottom bar. */
val tabScreens = listOf(Screen.Charge, Screen.History, Screen.Presets)
