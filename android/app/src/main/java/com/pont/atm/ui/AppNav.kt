package com.pont.atm.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun AppNav() {
    var screen by remember { mutableStateOf<Screen>(Screen.Login) }
    Column(Modifier.fillMaxSize().background(PontColors.Bg).statusBarsPadding()) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            Text(screen::class.simpleName ?: "", style = PontType.display(28))
        }
        if (screen in tabScreens) TabBar(selected = screen, onSelect = { screen = it })
    }
}

@Composable
fun TabBar(selected: Screen, onSelect: (Screen) -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(PontColors.Paper).navigationBarsPadding().height(66.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        listOf(Screen.Charge to "Charge", Screen.History to "History", Screen.Presets to "Presets").forEach { (s, label) ->
            Box(Modifier.weight(1f).fillMaxSize().clickable { onSelect(s) }, contentAlignment = Alignment.Center) {
                Text(
                    label, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    color = if (s == selected) PontColors.Ink else PontColors.Ink3,
                    modifier = Modifier.padding(4.dp),
                )
            }
        }
    }
}
