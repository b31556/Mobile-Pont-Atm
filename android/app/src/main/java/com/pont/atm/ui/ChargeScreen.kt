package com.pont.atm.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun ChargeScreen(
    pad: NumpadState, presets: List<Int>, instant: Boolean,
    terminal: String, operator: String, online: Boolean,
    onPreset: (Int) -> Unit, onCharge: () -> Unit, onMenu: () -> Unit,
) {
    val amount = pad.amount
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            val chip = RoundedCornerShape(999.dp)
            Row(
                Modifier.clip(chip).background(PontColors.Paper).border(1.dp, PontColors.Line, chip).clickable(onClick = onMenu).padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(Modifier.size(8.dp).background(if (online) PontColors.Green else PontColors.Red, CircleShape))
                Text("$terminal · $operator", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
            }
            Text(if (online) "Online" else "No connection", color = if (online) PontColors.GreenDark else PontColors.Red, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
        }
        val card = RoundedCornerShape(20.dp)
        Column(Modifier.padding(horizontal = 16.dp).padding(top = 6.dp).fillMaxWidth().clip(card).background(PontColors.Paper).border(1.dp, PontColors.Line, card).padding(horizontal = 18.dp, vertical = 12.dp)) {
            Text("Points to give", color = PontColors.Ink2, fontSize = 13.sp)
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 2.dp)) {
                Text(pad.display, style = PontType.display(72), color = if (amount == 0) Color(0xFFB7C1C8) else PontColors.Ink)
                Text("pts", color = PontColors.Ink2, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, modifier = Modifier.padding(bottom = 12.dp))
            }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            presets.forEach { p ->
                val s = RoundedCornerShape(12.dp)
                Box(
                    Modifier.height(42.dp).widthIn(min = 58.dp).clip(s).background(PontColors.AmberLight).border(1.dp, Color(0xFFF0D79A), s).clickable { onPreset(p) }.padding(horizontal = 14.dp),
                    contentAlignment = Alignment.Center,
                ) { Text("$p", style = PontType.display(17, FontWeight.Bold), color = Color(0xFF6B4A00)) }
            }
        }
        Text(
            if (instant) "Tap a preset to start reading right away" else "Tap a preset to fill the amount",
            color = PontColors.Ink3, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 18.dp),
        )
        Column(Modifier.weight(1f).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("123", "456", "789", "C0<").forEach { row ->
                Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { k ->
                        Key(k, Modifier.weight(1f).fillMaxHeight()) {
                            when (k) { 'C' -> pad.clear(); '<' -> pad.backspace(); else -> pad.press(k) }
                        }
                    }
                }
            }
        }
        GoButton(
            if (amount == 0) "Enter an amount" else "Give $amount ${if (amount == 1) "point" else "points"}",
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp), enabled = amount > 0, onClick = onCharge,
        )
    }
}

@Composable
private fun Key(k: Char, modifier: Modifier, onClick: () -> Unit) {
    val s = RoundedCornerShape(14.dp)
    val sub = k == 'C' || k == '<'
    Box(
        modifier.clip(s).background(if (sub) Color(0xFFE6EBEE) else PontColors.Paper).border(1.dp, PontColors.Line, s).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(if (k == '<') "⌫" else k.toString(), style = PontType.display(24, FontWeight.Bold), color = if (sub) PontColors.Ink2 else PontColors.Ink) }
}
