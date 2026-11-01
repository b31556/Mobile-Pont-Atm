package com.pont.atm.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pont.atm.core.InfoOutcome
import com.pont.atm.core.InfoResult
import com.pont.atm.core.InfoState
import com.pont.atm.core.PontApi

/**
 * The info kiosk: no buttons. It waits for a card and shows the holder's points and recent history, then goes
 * back to waiting. Nothing is changed by a tap. The terminal name at the bottom opens the menu with a long press.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun InfoScreen(state: InfoState, api: PontApi, terminal: String, onMenu: () -> Unit, onDebugTag: (String) -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (state) {
                InfoState.Idle, is InfoState.Sending -> InfoWaiting(sending = state is InfoState.Sending, onDebugTag = onDebugTag)
                is InfoState.Showing -> when (val o = state.outcome) {
                    is InfoOutcome.Done -> InfoCardView(o.result, api)
                    is InfoOutcome.Blocked -> Refused(infoRefusalCopy(o)!!, o.name, o.photoUrl, api)
                    else -> Refused(infoRefusalCopy(o)!!, null, null, api)
                }
            }
        }
        Text(
            terminal, color = if (state is InfoState.Showing) PontColors.Ink3 else Muted, fontSize = 13.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().combinedClickable(onClick = {}, onLongClick = onMenu).padding(vertical = 18.dp),
        )
    }
}

@Composable
private fun InfoWaiting(sending: Boolean, onDebugTag: (String) -> Unit) {
    Column(Modifier.fillMaxSize().padding(horizontal = 28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(if (sending) "One moment…" else "Tap a card to see its points", style = PontType.display(36), color = Color.White, textAlign = TextAlign.Center)
        Rings(Modifier.padding(vertical = 40.dp))
        DebugTapButtons(onDebugTag)
    }
}

@Composable
private fun InfoCardView(r: InfoResult, api: PontApi) {
    Column(Modifier.fillMaxSize()) {
        Header(PontColors.Green) {
            Avatar(api, r.card.photoUrl, r.card.name, 104.dp, ring = Color.White)
            Text(r.card.name, style = PontType.display(26), color = Color.White, modifier = Modifier.padding(top = 10.dp), textAlign = TextAlign.Center)
            Row(verticalAlignment = Alignment.Bottom) {
                Text("${r.card.balance}", style = PontType.display(72), color = Color.White)
                Text(if (r.card.balance == 1) "point" else "points", color = Color(0xD9FFFFFF), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 6.dp, bottom = 12.dp))
            }
        }
        Text("Recent activity", fontWeight = FontWeight.Bold, color = PontColors.Ink2, fontSize = 13.sp, modifier = Modifier.padding(start = 24.dp, top = 14.dp, bottom = 4.dp))
        if (r.history.isEmpty()) {
            Text("Nothing yet", color = PontColors.Ink3, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
        } else {
            LazyColumn(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                itemsIndexed(r.history) { _, row -> InfoHistoryRow(row) }
            }
        }
    }
}

@Composable
private fun InfoHistoryRow(row: com.pont.atm.core.InfoRow) {
    val copy = infoRowCopy(row)
    val dim = copy.reversed
    val amountColor = when { dim -> PontColors.Ink3; row.amount < 0 -> PontColors.Red; else -> PontColors.GreenDark }
    val strike = if (dim) TextDecoration.LineThrough else null
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text(copy.title, fontWeight = FontWeight.Bold, color = if (dim) PontColors.Ink3 else PontColors.Ink, textDecoration = strike, maxLines = 1)
            copy.detail?.let { Text(it, color = PontColors.Ink3, fontSize = 12.sp, maxLines = 1) }
            Text(infoRowTime(row.at), color = PontColors.Ink3, fontSize = 12.sp)
        }
        if (dim) Box(Modifier.clip(RoundedCornerShape(999.dp)).background(PontColors.RedLight).padding(horizontal = 8.dp, vertical = 2.dp)) { Text("Reversed", color = PontColors.Red, fontWeight = FontWeight.Bold, fontSize = 11.sp) }
        Text(signedAmount(row.amount), style = PontType.display(18), color = amountColor, textDecoration = strike)
    }
}
