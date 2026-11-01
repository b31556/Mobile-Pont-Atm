package com.pont.card.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pont.card.core.ProgramDay
import com.pont.card.core.ProgramDoc
import com.pont.card.core.ProgramEvent
import com.pont.card.core.ProgramMath
import com.pont.card.core.ProgramState
import com.pont.card.core.hm
import com.pont.card.core.range

private const val STEP = 30

/** What is open at a chosen moment: a graph of how busy the day is to drag along, and below it the events open then, soonest closing first. */
@Composable
fun PulseTab(
    state: ProgramState, day: ProgramDay, t: Int, nowMin: Int?, following: Boolean, onT: (Int) -> Unit, onNow: () -> Unit,
    onOpen: (String) -> Unit, onLike: (String) -> Unit,
) {
    val p = palette
    val events = state.eventsOn(day.key)
    val (d0, d1) = ProgramMath.domain(events)
    val at = t.coerceIn(d0, d1 - 1)
    val cells = (d0 until d1 step STEP).toList()
    val counts = cells.map { m -> events.count { it.s <= m && it.e > m } }
    val maxCount = (counts.maxOrNull() ?: 1).coerceAtLeast(1)
    val open = events.filter { it.s <= at && it.e > at }
    val soon = open.filter { it.e - at <= 30 }.sortedBy { it.e }
    val next = events.filter { it.s > at && it.s - at <= 30 }.sortedBy { it.s }
    val rest = open.filter { it !in soon }.sortedWith(compareByDescending<ProgramEvent> { ProgramMath.perHour(it) }.thenBy { it.title })
    var widthPx by remember { mutableIntStateOf(1) }
    val setFromX = { x: Float -> onT(((d0 + (x / widthPx).coerceIn(0f, 1f) * (d1 - d0)) / 5).toInt() * 5) }

    LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(hm(at), style = Type.display(28), color = p.ink)
                Text("${open.size} open, ${soon.size} close within 30 min", color = p.ink2, fontSize = 13.sp, modifier = Modifier.weight(1f).padding(bottom = 4.dp))
                when {
                    nowMin != null && following -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp), modifier = Modifier.padding(bottom = 6.dp)) {
                        Box(Modifier.size(8.dp).background(p.green, CircleShape))
                        Text("Live", color = p.green, fontWeight = FontWeight.ExtraBold, fontSize = 12.sp)
                    }
                    nowMin != null -> Text("Now ${hm(nowMin)}", color = p.green, fontWeight = FontWeight.ExtraBold, fontSize = 12.sp,
                        modifier = Modifier.padding(bottom = 4.dp).clip(RoundedCornerShape(50)).background(p.greenSoft).clickable(role = Role.Button, onClick = onNow).padding(horizontal = 10.dp, vertical = 6.dp))
                }
            }
        }
        item {
            Column(Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(18.dp)).padding(12.dp, 12.dp, 12.dp, 8.dp)) {
                BoxWithConstraints(
                    Modifier.fillMaxWidth().height(70.dp).onSizeChanged { widthPx = it.width.coerceAtLeast(1) }
                        .pointerInput(d0, d1) { detectTapGestures { setFromX(it.x) } }
                        .pointerInput(d0, d1) { detectHorizontalDragGestures { change, _ -> change.consume(); setFromX(change.position.x) } },
                ) {
                    val width = maxWidth
                    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.Bottom) {
                        cells.forEachIndexed { i, m ->
                            Box(
                                Modifier.weight(1f).fillMaxHeight((counts[i].toFloat() / maxCount).coerceIn(0.14f, 1f))
                                    .clip(RoundedCornerShape(topStart = 5.dp, topEnd = 5.dp, bottomStart = 2.dp, bottomEnd = 2.dp))
                                    .background(if (at >= m && at < m + STEP) p.green else p.line),
                            )
                        }
                    }
                    Box(Modifier.offset(x = width * ((at - d0).toFloat() / (d1 - d0)) - 1.5.dp).width(3.dp).fillMaxHeight().background(p.ink, RoundedCornerShape(2.dp)))
                    Box(Modifier.offset(x = width * ((at - d0).toFloat() / (d1 - d0)) - 8.dp, y = (-4).dp).size(16.dp).background(p.ink, CircleShape).border(3.dp, p.surface, CircleShape))
                }
                Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    for (i in 0..4) Text(hm(d0 + i * (d1 - d0) / 4), color = p.ink3, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        if (soon.isNotEmpty()) { item { GroupTitle("Closing soon") }; items(soon, key = { "s" + it.id }) { PulseCard(it, at, state, onOpen, onLike) } }
        if (next.isNotEmpty()) { item { GroupTitle("Starting in the next 30 min") }; items(next, key = { "n" + it.id }) { PulseCard(it, at, state, onOpen, onLike) } }
        item { GroupTitle("Open now, best first (${rest.size})") }
        if (rest.isEmpty()) item { Text("Nothing is open at this time.", color = p.ink2, modifier = Modifier.fillMaxWidth().padding(24.dp)) }
        items(rest, key = { "r" + it.id }) { PulseCard(it, at, state, onOpen, onLike) }
        item { Box(Modifier.height(12.dp)) }
    }
}

@Composable
fun GroupTitle(text: String) {
    Text(text.uppercase(), color = palette.ink3, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp, modifier = Modifier.padding(start = 16.dp, top = 6.dp))
}

@Composable
private fun PulseCard(e: ProgramEvent, t: Int, state: ProgramState, onOpen: (String) -> Unit, onLike: (String) -> Unit) {
    val p = palette
    val c = kindColors(e.kindKey)
    val planned = state.placed[e.id]
    val perHour = ProgramMath.perHour(e)
    val (d0, d1) = ProgramMath.domain(state.eventsOn(e.day))
    Column(
        Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(16.dp))
            .clickable(role = Role.Button) { onOpen(e.id) }.padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(e.title, color = p.ink, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp, maxLines = 2)
                Text("${e.room} · ${e.range()}", color = p.ink2, fontSize = 13.sp, maxLines = 1)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("$perHour", style = Type.display(22), color = p.ink)
                Text(if (ProgramMath.maxPts(e) <= perHour) "total" else "in 1 hour", color = p.ink3, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            KindChip(e)
            // where in the day this event is open, and where "now" is
            BoxWithConstraints(Modifier.weight(1f).height(12.dp)) {
                val w = maxWidth
                val span = (d1 - d0).coerceAtLeast(1).toFloat()
                Box(Modifier.align(Alignment.Center).fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(p.line))
                Box(Modifier.align(Alignment.CenterStart).offset(x = w * ((e.s - d0) / span)).width(w * (e.window / span)).height(6.dp).clip(RoundedCornerShape(3.dp)).background(c.fg.copy(alpha = 0.55f)))
                Box(Modifier.align(Alignment.CenterStart).offset(x = w * ((t - d0) / span) - 1.5.dp).width(3.dp).height(12.dp).background(p.ink, RoundedCornerShape(2.dp)))
            }
            if (planned != null) {
                Text(hm(planned.start), color = p.green, fontWeight = FontWeight.ExtraBold, fontSize = 11.sp, modifier = Modifier.clip(RoundedCornerShape(50)).background(p.greenSoft).padding(horizontal = 8.dp, vertical = 2.dp))
            } else {
                val soon = e.s <= t && e.e - t <= 30
                Text(
                    if (e.s > t) "in ${e.s - t} min" else if (e.open) "open" else "${e.e - t} min left",
                    color = if (soon) p.red else p.ink2, fontWeight = FontWeight.Bold, fontSize = 12.sp,
                )
            }
            HeartButton(e.id in state.likes, "Like ${e.title}", { onLike(e.id) }, Modifier.size(34.dp))
        }
    }
}
