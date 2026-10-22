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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pont.atm.core.PontApi
import com.pont.atm.core.Tx
import com.pont.atm.core.formatTime
import kotlinx.coroutines.launch

@Composable
fun HistoryScreen(vm: HistoryViewModel, api: PontApi, terminal: String, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Column(Modifier.padding(horizontal = 18.dp, vertical = 8.dp)) {
                Text("History", style = PontType.display(26))
                Text("Today on $terminal. Tap a row to storno.", color = PontColors.Ink2, fontSize = 13.sp)
            }
            if (vm.rows.isEmpty()) {
                Text(if (vm.loading) "Loading…" else "No charges yet. They show up here after the first tap.", color = PontColors.Ink3, modifier = Modifier.padding(18.dp))
            }
            LazyColumn(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                items(vm.rows, key = { it.id }) { tx -> Row(tx, api) { vm.open(tx.id) } }
            }
        }
        val t = vm.target
        if (t != null) BottomSheet(onDismiss = vm::dismiss) {
            if (vm.confirming) {
                Text("Storno ${t.amount} points?", style = PontType.display(22))
                Text("${t.card.name} will lose ${t.amount} points. The card isn't needed.", color = PontColors.Ink2)
                SheetButtons("Keep", vm::dismiss, "Storno", { scope.launch { vm.confirmStorno(); onChanged() } })
            } else {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Avatar(api, t.card.photoUrl, t.card.name, 44.dp)
                    Column(Modifier.weight(1f)) { Text(t.card.name, fontWeight = FontWeight.Bold); Text("T-${t.id}", color = PontColors.Ink3, fontSize = 12.sp) }
                    Text("+${t.amount}", style = PontType.display(18), color = PontColors.GreenDark)
                }
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).border(1.dp, PontColors.Line, RoundedCornerShape(14.dp)).padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    listOf("Time" to formatTime(t.createdAt), "Operator" to t.operator, "Status" to if (t.status == "stornoed") "Stornoed" else "Completed").forEach { (k, v) ->
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(k, color = PontColors.Ink2, fontSize = 13.sp); Text(v, fontWeight = FontWeight.SemiBold, fontSize = 13.sp) }
                    }
                }
                SheetButtons("Close", vm::dismiss, if (t.status == "stornoed") null else "Storno…", vm::askStorno)
            }
        }
    }
}

@Composable
private fun Row(tx: Tx, api: PontApi, onClick: () -> Unit) {
    val voided = tx.status == "stornoed"
    androidx.compose.foundation.layout.Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(api, tx.card.photoUrl, tx.card.name, 44.dp)
        Column(Modifier.weight(1f)) {
            Text(tx.card.name, fontWeight = FontWeight.Bold, color = if (voided) PontColors.Ink3 else PontColors.Ink, maxLines = 1)
            Text("${formatTime(tx.createdAt)} · T-${tx.id}", color = PontColors.Ink3, fontSize = 12.sp)
        }
        if (voided) Box(Modifier.clip(RoundedCornerShape(999.dp)).background(PontColors.RedLight).padding(horizontal = 8.dp, vertical = 2.dp)) { Text("Stornoed", color = PontColors.Red, fontWeight = FontWeight.Bold, fontSize = 11.sp) }
        Text("+${tx.amount}", style = PontType.display(18), color = if (voided) PontColors.Ink3 else PontColors.GreenDark, textDecoration = if (voided) TextDecoration.LineThrough else null)
    }
}
