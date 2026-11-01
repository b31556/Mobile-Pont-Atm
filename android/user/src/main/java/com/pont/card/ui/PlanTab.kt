package com.pont.card.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import com.pont.card.core.Placed
import com.pont.card.core.Placement
import com.pont.card.core.ProgramDay
import com.pont.card.core.ProgramEvent
import com.pont.card.core.ProgramMath
import com.pont.card.core.ProgramState
import com.pont.card.core.duration
import com.pont.card.core.hm
import com.pont.card.core.range
import kotlin.math.max
import kotlin.math.roundToInt

/** Where a dragged card would land on the line, or that it can't. */
private data class Ghost(val fit: Placement?, val shown: Placement)

/**
 * The plan: one event card on top and, below it, your whole day as one line. Drag the card onto the line to put it in your day, pull the
 * edges of a block to choose how long you stay, and the points follow. The colour on the line is when the card's event is held.
 */
@Composable
fun PlanTab(
    state: ProgramState, day: ProgramDay, nowMin: Int?,
    queueAll: Boolean, onQueue: (Boolean) -> Unit, idx: Int, onIdx: (Int) -> Unit,
    selId: String?, onSel: (String?) -> Unit,
    onPlace: (String, Placement) -> Unit, onRemove: (String) -> Unit, onLive: (String, Placement?) -> Unit,
    onLike: (String) -> Unit, onOpen: (String) -> Unit,
) {
    val p = palette
    val events = state.eventsOn(day.key)
    val (d0, d1) = ProgramMath.domain(events)
    val snap = ProgramMath.snapFor(d1 - d0)
    val queue = events.filter { it.id !in state.placed && (queueAll || it.id in state.likes) }
        .sortedWith(compareBy<ProgramEvent> { it.open }.thenBy { it.s }.thenByDescending { ProgramMath.maxPts(it) })
    val card = if (queue.isEmpty()) null else queue[((idx % queue.size) + queue.size) % queue.size]
    val mine = state.placedOn(day.key)
    val sel = mine.firstOrNull { it.event.id == selId }

    val density = LocalDensity.current
    var cardPos by remember { mutableStateOf(Offset.Zero) }
    var track by remember { mutableStateOf(Rect.Zero) }
    var dragging by remember { mutableStateOf(false) }
    var drag by remember { mutableStateOf(Offset.Zero) }
    var ghost by remember { mutableStateOf<Ghost?>(null) }

    fun ghostAt(e: ProgramEvent, pointer: Offset): Ghost? {
        val pad = with(density) { 36.dp.toPx() }
        val over = pointer.y > track.top - pad && pointer.y < track.bottom + pad && pointer.x > track.left - 20f && pointer.x < track.right + 20f
        if (!over || track.width <= 0f) return null
        val d = ProgramMath.defaultDur(e)
        val want = ((d0 + (pointer.x - track.left) / track.width * (d1 - d0) - d / 2f) / snap).roundToInt() * snap
        val fit = ProgramMath.fitAt(e, want, d, mine.map { it.at }, snap)
        return Ghost(fit, fit ?: Placement(want, d))
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState(), enabled = !dragging).padding(bottom = 16.dp)) {
        // which events the cards come from, and moving through them
        Row(Modifier.padding(horizontal = 16.dp).padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.clip(RoundedCornerShape(50)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(50)).padding(3.dp)) {
                listOf(false to "Liked", true to "All").forEach { (all, label) ->
                    Text(
                        label, color = if (queueAll == all) p.bg else p.ink2, fontWeight = FontWeight.ExtraBold, fontSize = 12.sp,
                        modifier = Modifier.clip(RoundedCornerShape(50)).background(if (queueAll == all) p.ink else p.surface)
                            .clickable(role = Role.Button) { onQueue(all); onIdx(0) }.padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                }
            }
            Text(
                if (card == null) "0 of 0" else "${((idx % queue.size) + queue.size) % queue.size + 1} of ${queue.size}",
                color = p.ink3, fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f).padding(start = 6.dp),
            )
            listOf("‹" to -1, "›" to 1).forEach { (glyph, step) ->
                Box(
                    Modifier.size(36.dp).clip(CircleShape).background(p.surface).border(1.5.dp, p.line, CircleShape)
                        .clickable(role = Role.Button) { onIdx(idx + step) }, contentAlignment = Alignment.Center,
                ) { Text(glyph, color = p.ink, fontWeight = FontWeight.ExtraBold, fontSize = 18.sp) }
            }
        }

        // the card to grab
        Box(Modifier.padding(horizontal = 16.dp).fillMaxWidth().zIndex(if (dragging) 10f else 0f)) {
            if (card == null) {
                Text(
                    if (!queueAll) "Nothing liked is left to place. Switch to All, or like more in Pulse." else "Everything for this day is on your line.",
                    color = p.ink2, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(22.dp)).background(p.surface).padding(28.dp),
                )
            } else {
                val c = kindColors(card.kindKey)
                Column(
                    Modifier.fillMaxWidth()
                        .onGloballyPositioned { cardPos = it.positionInRoot() }
                        .offset { IntOffset(drag.x.roundToInt(), drag.y.roundToInt()) }
                        .graphicsLayer {
                            // small and see-through over the line, so the line stays visible
                            val near = if (dragging) (drag.y / max(60f, track.top - cardPos.y)).coerceIn(0f, 1f) else 0f
                            scaleX = 1f - 0.4f * near; scaleY = 1f - 0.4f * near; alpha = 1f - 0.5f * near
                        }
                        .clip(RoundedCornerShape(22.dp)).background(p.surface)
                        .border(if (dragging) 2.dp else 1.dp, if (dragging) c.fg else p.line, RoundedCornerShape(22.dp))
                        .pointerInput(card.id) { detectTapGestures(onTap = { onOpen(card.id) }) }
                        .pointerInput(card.id, d0, d1, mine, snap) {
                            var origin = Offset.Zero
                            var startLocal = Offset.Zero
                            detectDragGestures(
                                onDragStart = { local -> origin = cardPos; startLocal = local; drag = Offset.Zero; dragging = true },
                                onDrag = { change, amount -> change.consume(); drag += amount; ghost = ghostAt(card, origin + startLocal + drag) },
                                onDragEnd = {
                                    val fit = ghost?.fit
                                    dragging = false; drag = Offset.Zero; ghost = null
                                    if (fit != null) { onPlace(card.id, fit); onSel(card.id) }
                                },
                                onDragCancel = { dragging = false; drag = Offset.Zero; ghost = null },
                            )
                        }
                        .padding(start = 14.dp, end = 14.dp, top = 11.dp, bottom = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        KindChip(card)
                        Box(Modifier.weight(1f))
                        HeartButton(card.id in state.likes, "Like ${card.title}", { onLike(card.id) }, Modifier.size(36.dp))
                    }
                    Text(card.title, style = Type.display(19), color = p.ink, maxLines = 2)
                    Text("${card.room} · ${if (card.open) "open " else ""}${card.range()}", color = p.ink2, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                    val perHour = ProgramMath.perHour(card)
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("$perHour", style = Type.display(34), color = p.ink)
                        Text(if (ProgramMath.maxPts(card) <= perHour) "points in total" else "points in the first hour", color = p.ink2, fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(bottom = 5.dp))
                    }
                    val rule = card.rule + if (card.bonus.isNotBlank()) " Bonus: ${card.bonus}." else ""
                    if (rule.isNotBlank()) Text(rule, color = p.ink2, fontSize = 13.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    if (card.model == "tasks" && card.items.size > 1) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            card.items.take(3).forEach { t ->
                                Text("${t.name.substringBefore(" (")} ${t.pts}", color = p.ink2, fontSize = 11.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false).clip(RoundedCornerShape(50)).background(p.bg).padding(horizontal = 8.dp, vertical = 2.dp))
                            }
                            if (card.items.size > 3) Text("+${card.items.size - 3}", color = p.ink2, fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.clip(RoundedCornerShape(50)).background(p.bg).padding(horizontal = 8.dp, vertical = 2.dp))
                        }
                    }
                    if (card.check.isNotBlank()) Text("Check: ${card.check}", color = p.amberInk, fontSize = 12.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.amberSoft).padding(horizontal = 8.dp, vertical = 4.dp))
                    Text("↓ DRAG ONTO YOUR DAY", color = p.ink3, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.5.sp, modifier = Modifier.fillMaxWidth(), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
            }
        }

        // your day
        val used = mine.sumOf { it.at.dur }
        Row(Modifier.padding(horizontal = 16.dp).padding(top = 8.dp, bottom = 4.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Bottom) {
            Text("Your ${day.label.substringBefore(' ')}", color = p.ink, fontWeight = FontWeight.ExtraBold, fontSize = 13.sp)
            Text("${mine.size} planned · ${duration(used)} · ${duration(max(0, d1 - d0 - used))} free", color = p.ink2, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }
        DayLine(
            d0, d1, card, mine, selId, nowMin, ghost, snap,
            onBounds = { track = it }, onSelect = { id -> onSel(if (selId == id) null else id) }, onCommit = onPlace, onLive = onLive,
            modifier = Modifier.padding(horizontal = 16.dp),
        )
        Text(
            if (card == null) "Tap a block to change it." else if (card.open) "The colour is when it is open. Drop the card anywhere inside it." else "The colour is when it is held. Drop the card inside it.",
            color = p.ink2, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
        )

        if (sel != null) {
            val others = mine.filter { it.event.id != sel.event.id }.map { it.at }
            val hi = minOf(sel.event.e, others.filter { it.start >= sel.at.end }.minOfOrNull { it.start } ?: Int.MAX_VALUE)
            StayPanel(sel, snap, hi, onNudge = { d -> onPlace(sel.event.id, sel.at.copy(dur = (sel.at.dur + d * snap).coerceIn(snap, hi - sel.at.start))) }, onRemove = { onRemove(sel.event.id); onSel(null) }, onDetails = { onOpen(sel.event.id) })
        } else if (mine.isEmpty()) {
            Text("Your day is empty. Drag a card onto the line.", color = p.ink2, modifier = Modifier.fillMaxWidth().padding(24.dp))
        } else {
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                mine.forEach { s ->
                    val c = kindColors(s.event.kindKey)
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(12.dp))
                            .clickable(role = Role.Button) { onSel(s.event.id) }.padding(horizontal = 10.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text("${hm(s.at.start)}–${hm(s.at.end)} · ${s.event.title}", color = p.ink, fontWeight = FontWeight.Bold, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 2)
                        Text(duration(s.at.dur), color = p.ink2, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        Text("+${ProgramMath.earn(s.event, s.at.dur)}", color = c.fg, fontWeight = FontWeight.ExtraBold, fontSize = 14.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun DayLine(
    d0: Int, d1: Int, event: ProgramEvent?, mine: List<Placed>, selId: String?, nowMin: Int?, ghost: Ghost?, snap: Int,
    onBounds: (Rect) -> Unit, onSelect: (String) -> Unit, onCommit: (String, Placement) -> Unit, onLive: (String, Placement?) -> Unit, modifier: Modifier,
) {
    val p = palette
    val shape = RoundedCornerShape(14.dp)
    BoxWithConstraints(modifier.fillMaxWidth().height(84.dp).clip(shape).background(p.surface).border(1.dp, p.line, shape).onGloballyPositioned { onBounds(it.boundsInRoot()) }) {
        val w = maxWidth
        val span = (d1 - d0).coerceAtLeast(1).toFloat()
        fun x(m: Int) = w * ((m - d0) / span)
        val c = kindColors(event?.kindKey ?: "time")

        if (event != null) {
            // outside the event's hours is dimmed; inside is its colour
            Box(Modifier.offset(x = 0.dp).width(x(event.s)).fillMaxHeight().background(p.line.copy(alpha = 0.45f)))
            Box(Modifier.offset(x = x(event.e)).width(w - x(event.e)).fillMaxHeight().background(p.line.copy(alpha = 0.45f)))
            Box(Modifier.offset(x = x(event.s)).width(x(event.e) - x(event.s)).fillMaxHeight().background(c.bg)) {
                Text("${if (event.open) "open " else "held "}${event.range()}", color = c.fg, fontSize = 10.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1, modifier = Modifier.align(Alignment.BottomStart).padding(start = 5.dp, bottom = 4.dp))
            }
        }
        val step = if (d1 - d0 > 300) 120 else 60
        for (h in d0..d1 step step) {
            Box(Modifier.offset(x = x(h)).width(1.dp).fillMaxHeight().background(p.line))
            Text(hm(h), color = p.ink3, fontSize = 10.sp, fontWeight = FontWeight.Bold, modifier = Modifier.offset(x = x(h) + 3.dp, y = 3.dp))
        }
        if (nowMin != null && nowMin in d0..d1) Box(Modifier.offset(x = x(nowMin)).width(2.dp).fillMaxHeight().background(p.red))

        mine.forEach { s ->
            val others = mine.filter { it.event.id != s.event.id }.map { it.at }
            val lo = max(s.event.s, others.filter { it.end <= s.at.start }.maxOfOrNull { it.end } ?: 0)
            val hi = minOf(s.event.e, others.filter { it.start >= s.at.end }.minOfOrNull { it.start } ?: Int.MAX_VALUE)
            StayBlock(s, selId == s.event.id, d0, d1, w, snap, lo, hi, { onSelect(s.event.id) }, onCommit, onLive)
        }
        if (ghost != null && event != null) {
            val g = ghost.shown
            val color = if (ghost.fit == null) p.red else c.fg
            Box(
                Modifier.offset(x = x(g.start), y = 20.dp).width(x(g.end) - x(g.start)).height(46.dp).clip(RoundedCornerShape(11.dp))
                    .background(if (ghost.fit == null) p.redSoft else c.bg).border(2.dp, color, RoundedCornerShape(11.dp)),
                contentAlignment = Alignment.Center,
            ) { Text(if (ghost.fit != null) "+${ProgramMath.earn(event, ghost.fit.dur)}" else "No room", color = color, fontWeight = FontWeight.ExtraBold, fontSize = 13.sp, maxLines = 1) }
        }
    }
}

/** One stay on the line. Drag it to move it, drag an edge to change how long you stay. Nothing leaves the event's hours or crosses another stay. */
@Composable
private fun StayBlock(
    s: Placed, selected: Boolean, d0: Int, d1: Int, trackW: androidx.compose.ui.unit.Dp, snap: Int, lo: Int, hi: Int,
    onTap: () -> Unit, onCommit: (String, Placement) -> Unit, onLive: (String, Placement?) -> Unit,
) {
    val p = palette
    val c = kindColors(s.event.kindKey)
    val density = LocalDensity.current
    val pxPerMin = with(density) { trackW.toPx() } / (d1 - d0).coerceAtLeast(1)
    var live by remember(s.at) { mutableStateOf(s.at) }
    val fixed = s.event.model == "flat"
    val span = (d1 - d0).coerceAtLeast(1).toFloat()
    val width = trackW * (live.dur / span)
    val shape = RoundedCornerShape(11.dp)
    val change = { next: Placement -> live = next; onLive(s.event.id, next) }
    val end = { onCommit(s.event.id, live); onLive(s.event.id, null) }

    Box(
        Modifier.offset(x = trackW * ((live.start - d0) / span), y = 20.dp).width(width).height(46.dp).clip(shape).background(c.bg)
            .border(if (selected) 3.dp else 2.dp, if (selected) p.ink else c.fg, shape)
            .pointerInput(s.event.id) { detectTapGestures(onTap = { onTap() }) }
            .pointerInput(s.event.id, lo, hi, snap, pxPerMin, s.at, fixed) {
                if (fixed) return@pointerInput
                var base = s.at
                var acc = 0f
                detectHorizontalDragGestures(
                    onDragStart = { base = live; acc = 0f },
                    onDragEnd = { end() },
                    onDragCancel = { live = s.at; onLive(s.event.id, null) },
                    onHorizontalDrag = { ch, dx ->
                        ch.consume(); acc += dx
                        val dm = (acc / pxPerMin / snap).roundToInt() * snap
                        change(base.copy(start = (base.start + dm).coerceIn(lo, max(lo, hi - base.dur))))
                    },
                )
            },
    ) {
        Row(Modifier.fillMaxSize().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            if (width >= 84.dp) Text(s.event.title, color = c.fg, fontWeight = FontWeight.ExtraBold, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            else Box(Modifier.weight(1f))
            Text("+${ProgramMath.earn(s.event, live.dur)}", color = c.fg, fontWeight = FontWeight.ExtraBold, fontSize = 13.sp, maxLines = 1)
        }
        if (!fixed && width > 44.dp) {
            EdgeGrip(Modifier.align(Alignment.CenterStart), c.fg, snap, pxPerMin, { live }, change, end) { acc, base ->
                val dm = (acc / pxPerMin / snap).roundToInt() * snap
                val start = (base.start + dm).coerceIn(lo, max(lo, base.end - snap))
                Placement(start, base.end - start)
            }
            EdgeGrip(Modifier.align(Alignment.CenterEnd), c.fg, snap, pxPerMin, { live }, change, end) { acc, base ->
                val dm = (acc / pxPerMin / snap).roundToInt() * snap
                Placement(base.start, (base.dur + dm).coerceIn(snap, max(snap, hi - base.start)))
            }
        }
    }
}

/** The grip on a block's edge: dragging it turns the stay it started from into [resize] of the distance dragged. */
@Composable
private fun EdgeGrip(
    modifier: Modifier, color: androidx.compose.ui.graphics.Color, snap: Int, pxPerMin: Float,
    live: () -> Placement, change: (Placement) -> Unit, end: () -> Unit, resize: (Float, Placement) -> Placement,
) {
    Box(
        modifier.width(18.dp).fillMaxHeight().pointerInput(snap, pxPerMin) {
            var base = live()
            var acc = 0f
            detectHorizontalDragGestures(
                onDragStart = { base = live(); acc = 0f },
                onDragEnd = { end() },
                onHorizontalDrag = { ch, dx -> ch.consume(); acc += dx; change(resize(acc, base)) },
            )
        },
        contentAlignment = Alignment.Center,
    ) { Box(Modifier.width(3.dp).height(18.dp).background(color.copy(alpha = 0.7f), RoundedCornerShape(2.dp))) }
}

/** What the selected stay is worth, a hint about the next points, and a −/+ stepper for those who would rather tap than drag. */
@Composable
private fun StayPanel(s: Placed, snap: Int, hi: Int, onNudge: (Int) -> Unit, onRemove: () -> Unit, onDetails: () -> Unit) {
    val p = palette
    val c = kindColors(s.event.kindKey)
    val pts = ProgramMath.earn(s.event, s.at.dur)
    val more = ProgramMath.nextStep(s.event, s.at.dur)
    Column(
        Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(16.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(s.event.title, color = p.ink, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp, modifier = Modifier.weight(1f), maxLines = 2)
            Text("+$pts", style = Type.display(24), color = c.fg)
        }
        Text("${hm(s.at.start)}–${hm(s.at.end)} · ${duration(s.at.dur)} · ${s.event.room}", color = p.ink2, fontSize = 13.sp)
        Text(
            when {
                s.event.model == "flat" -> "You have to stay until the end for these points."
                more != null -> "Stay $more min more for +${ProgramMath.earn(s.event, s.at.dur + more) - pts}."
                pts >= ProgramMath.maxPts(s.event) -> "That is everything this event gives."
                else -> "No more points for staying longer here."
            },
            color = p.green, fontWeight = FontWeight.Bold, fontSize = 12.sp,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (s.event.model != "flat") {
                PanelButton("− $snap min", p.ink) { onNudge(-1) }
                PanelButton("+ $snap min", p.ink) { onNudge(1) }
            }
            PanelButton("Details", p.ink, onClick = onDetails)
            Box(Modifier.weight(1f))
            PanelButton("Remove", p.red, onClick = onRemove)
        }
    }
}

@Composable
private fun PanelButton(text: String, color: androidx.compose.ui.graphics.Color, onClick: () -> Unit) {
    val p = palette
    Box(
        Modifier.heightIn(min = 40.dp).clip(RoundedCornerShape(10.dp)).background(p.surface).border(1.5.dp, p.line, RoundedCornerShape(10.dp))
            .clickable(role = Role.Button, onClick = onClick).padding(horizontal = 12.dp), contentAlignment = Alignment.Center,
    ) { Text(text, color = color, fontWeight = FontWeight.ExtraBold, fontSize = 13.sp) }
}
