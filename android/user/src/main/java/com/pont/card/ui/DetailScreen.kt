package com.pont.card.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pont.card.core.CardItem
import com.pont.card.core.HistoryEntry
import com.pont.card.core.ItemState
import com.pont.card.core.Notice
import com.pont.card.core.RowCopy
import com.pont.card.core.RowKind
import com.pont.card.core.Sign
import com.pont.card.core.dayHeading
import com.pont.card.core.groupByDay
import com.pont.card.core.rowCopy
import com.pont.card.core.timeOfDay

/** One thing in the scrolling list of a card's detail. */
private sealed interface Line {
    data class Day(val title: String) : Line
    data class Row(val entry: HistoryEntry, val key: String) : Line
}

private fun lines(history: List<HistoryEntry>): List<Line> =
    groupByDay(history).flatMap { g ->
        listOf<Line>(Line.Day(dayHeading(g.day))) + g.entries.mapIndexed { i, e -> Line.Row(e, "${g.day}-$i-${e.at}") }
    }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailScreen(item: CardItem?, notice: Notice?, loading: Boolean, onBack: () -> Unit, onRefresh: () -> Unit, onRemove: () -> Unit) {
    val p = palette
    var confirming by remember { mutableStateOf(false) }
    val card = item?.card
    Column(Modifier.fillMaxSize().background(p.bg).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { Text("‹ Back", color = p.green, fontWeight = FontWeight.Bold, fontSize = 17.sp) }
            Spacer(Modifier.weight(1f))
            if (item != null) TextButton(onClick = { confirming = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Remove", color = p.red, fontWeight = FontWeight.Bold, fontSize = 16.sp) }
        }
        PullToRefreshBox(isRefreshing = loading, onRefresh = onRefresh, modifier = Modifier.weight(1f)) {
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item { Hero(item) }
                notice?.let { n -> item { Banner(noticeText(n), if (n is Notice.Offline) Tone.Warn else Tone.Bad) } }
                if (card?.blocked == true) item { Banner("Blocked", Tone.Bad, big = true) }
                when {
                    item == null -> item { Note("This card is not on this phone any more.") }
                    item.state == ItemState.NotRegistered -> item { Note("This card isn't registered any more. You can remove it from this phone.") }
                    card == null -> item { Note("Can't load this card yet. Pull down to try again.") }
                    card.history.isEmpty() -> item { Note("Nothing yet") }
                    else -> items(lines(card.history), key = { if (it is Line.Row) it.key else (it as Line.Day).title }) { line ->
                        when (line) {
                            is Line.Day -> Text(line.title, color = p.ink2, fontWeight = FontWeight.Bold, fontSize = 15.sp, modifier = Modifier.padding(top = 14.dp, bottom = 2.dp, start = 4.dp))
                            is Line.Row -> HistoryRow(line.entry)
                        }
                    }
                }
            }
        }
    }
    if (confirming && item != null) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            containerColor = p.surface,
            title = { Text("Remove this card?", color = p.ink, fontWeight = FontWeight.Bold) },
            text = { Text("${card?.name?.ifBlank { null } ?: "This card"} will no longer be shown on this phone. The card itself isn't changed, and you can add it again.", color = p.ink2) },
            confirmButton = { TextButton(onClick = { confirming = false; onRemove() }) { Text("Remove", color = p.red, fontWeight = FontWeight.Bold) } },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("Keep", color = p.ink, fontWeight = FontWeight.Bold) } },
        )
    }
}

@Composable
private fun Hero(item: CardItem?) {
    val p = palette
    val card = item?.card
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Avatar(card?.photo, card?.name.orEmpty().ifEmpty { "?" }, 150.dp)
        Text(card?.name?.ifBlank { null } ?: "Card", style = Type.display(30), color = p.ink, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 16.dp))
        if (card != null) {
            Text("${card.balance}", style = Type.display(88), color = p.ink, maxLines = 1, modifier = Modifier.padding(top = 4.dp))
            Text(if (card.balance == 1) "point" else "points", color = p.ink3, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 8.dp))
        }
    }
}

@Composable
private fun Note(text: String) {
    Text(text, color = palette.ink2, fontSize = 17.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp, horizontal = 12.dp))
}

private fun glyph(kind: RowKind) = when (kind) {
    RowKind.Received -> "★"
    RowKind.CheckOut -> "→"
    RowKind.Refund -> "↩"
    RowKind.Adjustment -> "✎"
    RowKind.Other -> "•"
}

@Composable
private fun HistoryRow(entry: HistoryEntry) {
    val p = palette
    val c: RowCopy = rowCopy(entry)
    val dim = c.reversed
    val (iconBg, iconFg) = when (c.kind) {
        RowKind.Received -> p.greenSoft to p.green
        RowKind.CheckOut -> p.amberSoft to (if (p.dark) p.amber else Color(0xFF8A5A00))
        RowKind.Refund -> p.redSoft to p.red
        RowKind.Adjustment, RowKind.Other -> p.line to p.ink2
    }
    val amountColor = when { dim -> p.ink3; c.sign == Sign.Plus -> p.green; c.sign == Sign.Minus -> p.red; else -> p.ink2 }
    val strike = if (dim) TextDecoration.LineThrough else null
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(p.surface).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.size(44.dp).clip(CircleShape).background(if (dim) p.line else iconBg), contentAlignment = Alignment.Center) {
            Text(glyph(c.kind), color = if (dim) p.ink3 else iconFg, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(c.title, color = if (dim) p.ink3 else p.ink, fontWeight = FontWeight.Bold, fontSize = 17.sp, textDecoration = strike, maxLines = 2)
            c.detail?.let { Text(it, color = p.ink3, fontSize = 14.sp, textDecoration = strike, maxLines = 2) }
            if (dim) Text("Reversed", color = p.red, fontWeight = FontWeight.Bold, fontSize = 13.sp)
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(c.amount, style = Type.display(22), color = amountColor, textDecoration = strike)
            Text(timeOfDay(entry.at), color = p.ink3, fontSize = 13.sp)
        }
    }
}
