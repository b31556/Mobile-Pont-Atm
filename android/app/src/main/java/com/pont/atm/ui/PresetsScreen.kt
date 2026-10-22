package com.pont.atm.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

@Composable
fun PresetsScreen(vm: PresetsViewModel, terminal: String) {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    val card = RoundedCornerShape(16.dp)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Column(Modifier.padding(horizontal = 18.dp, vertical = 8.dp)) {
            Text("Presets", style = PontType.display(26))
            Text("Shown on the keypad for every operator on $terminal.", color = PontColors.Ink2, fontSize = 13.sp)
        }
        Row(Modifier.padding(horizontal = 16.dp).padding(bottom = 10.dp).fillMaxWidth().clip(card).background(PontColors.Paper).border(1.dp, PontColors.Line, card).padding(14.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f)) {
                Text("Tap once, then card", fontWeight = FontWeight.Bold)
                Text("A preset starts reading right away. Off: it only fills the amount.", color = PontColors.Ink2, fontSize = 13.sp)
            }
            PontSwitch(vm.instant, "Start reading right away") { scope.launch { vm.setInstant(it) } }
        }
        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (vm.values.isEmpty()) Text("No presets yet. Add one below.", color = PontColors.Ink3, modifier = Modifier.padding(vertical = 8.dp))
            vm.values.forEach { v ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(PontColors.Paper).border(1.dp, PontColors.Line, RoundedCornerShape(14.dp)).padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text("$v", style = PontType.display(28), modifier = Modifier.width(70.dp))
                    Text("pts", color = PontColors.Ink3, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    Box(Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).clickable { scope.launch { vm.remove(v) } }, contentAlignment = Alignment.Center) {
                        Text("✕", color = PontColors.Red, fontWeight = FontWeight.Bold)
                    }
                }
            }
            Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = text, onValueChange = { text = it.filter(Char::isDigit).take(4) }, singleLine = true,
                    placeholder = { Text("New preset, e.g. 5") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    shape = RoundedCornerShape(12.dp), modifier = Modifier.weight(1f),
                )
                Box(Modifier.height(56.dp).clip(RoundedCornerShape(12.dp)).background(PontColors.Ink).clickable { scope.launch { if (vm.add(text)) text = "" } }.padding(horizontal = 20.dp), contentAlignment = Alignment.Center) {
                    Text("Add", color = androidx.compose.ui.graphics.Color.White, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}
