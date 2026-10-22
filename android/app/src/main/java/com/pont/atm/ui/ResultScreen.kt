package com.pont.atm.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pont.atm.core.ChargeOutcome
import com.pont.atm.core.FlowState
import com.pont.atm.core.PontApi
import com.pont.atm.core.StornoResult
import com.pont.atm.core.formatTime
import kotlinx.coroutines.launch

@Composable
fun ResultScreen(
    done: FlowState.Done, api: PontApi, terminal: String,
    onNext: () -> Unit, onSame: () -> Unit, onRetry: () -> Unit,
    onStorno: suspend (Long) -> Result<StornoResult>, onSuggest: suspend (String) -> Result<Unit>,
) {
    when (val o = done.outcome) {
        is ChargeOutcome.Success -> SuccessResult(done.amount, o, api, terminal, onNext, onSame, onStorno)
        else -> {
            val copy = refusalCopy(o, done.uid)!!
            val holder = (o as? ChargeOutcome.Blocked)
            // After a lost connection the operator can tap the same card again; the same key makes the server answer once.
            val retry = if (o is ChargeOutcome.NoConnection || o is ChargeOutcome.Failed) onRetry else null
            val suggest = if (o is ChargeOutcome.UnknownCard) onSuggest else null
            Refusal(copy.title, copy.message, holder?.name, holder?.photoUrl, api, retry, onNext, done.uid, suggest)
        }
    }
}

@Composable
private fun Header(color: Color, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(bottomStart = 28.dp, bottomEnd = 28.dp)).background(color).padding(horizontal = 20.dp, vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) { content() }
}

@Composable
private fun SuccessResult(amount: Int, o: ChargeOutcome.Success, api: PontApi, terminal: String, onNext: () -> Unit, onSame: () -> Unit, onStorno: suspend (Long) -> Result<StornoResult>) {
    var stornoed by remember { mutableStateOf<StornoResult?>(null) }
    var asking by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val balance = stornoed?.card?.balance ?: o.card.balance
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Header(if (stornoed != null) PontColors.Ink2 else PontColors.Green) {
                Text(if (stornoed != null) "Stornoed" else "✓", color = Color.White, fontWeight = FontWeight.Bold, fontSize = if (stornoed != null) 15.sp else 36.sp)
                Row(verticalAlignment = Alignment.Bottom) {
                    Text((if (stornoed != null) "−" else "+") + amount, style = PontType.display(54), color = Color.White)
                    Text(if (amount == 1) "point" else "points", color = Color(0xD9FFFFFF), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 6.dp, bottom = 8.dp))
                }
            }
            Column(Modifier.fillMaxWidth().padding(top = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Avatar(api, o.card.photoUrl, o.card.name, 148.dp, ring = if (stornoed != null) PontColors.Ink3 else PontColors.Green)
                Text(o.card.name, style = PontType.display(26), modifier = Modifier.padding(top = 14.dp), textAlign = TextAlign.Center)
                Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (stornoed == null) Text("${o.card.balanceBefore}", color = PontColors.Ink3, fontSize = 17.sp, textDecoration = androidx.compose.ui.text.style.TextDecoration.LineThrough)
                    if (stornoed == null) Text("→", color = PontColors.Ink2, fontSize = 17.sp)
                    Text("$balance", style = PontType.display(22))
                    Text("pts", color = PontColors.Ink2, fontSize = 17.sp)
                }
            }
            MetaCard(listOf("Transaction" to "T-${o.tx.id}", "Time" to formatTime(o.tx.createdAt), "Terminal" to terminal))
            error?.let { Text(it, color = PontColors.Red, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp)) }
            Spacer(Modifier.weight(1f))
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (stornoed == null) {
                    // Straight back to waiting for a card, same amount: no trip through the keypad.
                    GoButton("One more like this · $amount ${if (amount == 1) "pt" else "pts"}", onClick = onSame)
                    GhostButton("Done", PontColors.Ink, onClick = onNext)
                    GhostButton("Storno this charge", PontColors.Red) { error = null; asking = true }
                } else {
                    GoButton("Done", onClick = onNext)
                }
            }
        }
        if (asking) BottomSheet(onDismiss = { asking = false }) {
            Text("Storno $amount points?", style = PontType.display(22))
            Text("${o.card.name} will lose $amount points (balance $balance → ${balance - amount}). The card isn't needed.", color = PontColors.Ink2)
            SheetButtons("Keep", { asking = false }, "Storno", {
                asking = false
                scope.launch { onStorno(o.tx.id).onSuccess { stornoed = it }.onFailure { error = it.message } }
            })
        }
    }
}

@Composable
private fun MetaCard(rows: List<Pair<String, String>>) {
    val s = RoundedCornerShape(14.dp)
    Column(Modifier.padding(horizontal = 16.dp).padding(top = 18.dp).fillMaxWidth().clip(s).background(PontColors.Paper).border(1.dp, PontColors.Line, s).padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        rows.forEach { (k, v) ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(k, color = PontColors.Ink2, fontSize = 13.sp); Text(v, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun Refusal(title: String, message: String, holder: String?, photo: String?, api: PontApi, onRetry: (() -> Unit)?, onNext: () -> Unit, uid: String, onSuggest: (suspend (String) -> Result<Unit>)?) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var suggested by remember { mutableStateOf(false) }
    var suggestError by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize()) {
        Header(PontColors.Red) {
            Text("✕", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 36.sp)
            Text(title, style = PontType.display(30), color = Color.White, textAlign = TextAlign.Center)
        }
        Column(Modifier.fillMaxWidth().padding(top = 22.dp, start = 24.dp, end = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (holder != null) {
                Avatar(api, photo.orEmpty(), holder, 148.dp, ring = PontColors.Red)
                Text(holder, style = PontType.display(26), modifier = Modifier.padding(top = 14.dp))
            } else {
                Box(Modifier.size(120.dp).background(Color(0xFFE3E8EB), CircleShape), contentAlignment = Alignment.Center) { Text("?", style = PontType.display(54), color = Color(0xFF9AA7B0)) }
            }
            Text(message, color = PontColors.Ink2, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 14.dp))
        }
        Spacer(Modifier.weight(1f))
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (onSuggest != null) {
                if (suggested) Text("✓ Suggested. An admin will see this card in the admin site.", color = PontColors.GreenDark, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp))
                else {
                    suggestError?.let { Text(it, color = PontColors.Red, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
                    GoButton(if (busy) "Sending…" else "Suggest for addition", enabled = !busy) {
                        scope.launch {
                            busy = true; suggestError = null
                            onSuggest(uid).onSuccess { suggested = true }.onFailure { suggestError = it.message }
                            busy = false
                        }
                    }
                }
            }
            if (onRetry != null) GoButton("Tap again", onClick = onRetry)
            GhostButton("Back to keypad", PontColors.Ink, onClick = onNext)
        }
    }
}
