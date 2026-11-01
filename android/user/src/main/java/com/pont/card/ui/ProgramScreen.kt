package com.pont.card.ui

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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.produceState
import kotlinx.coroutines.delay
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pont.card.core.Placement
import com.pont.card.core.ProgramDay
import com.pont.card.core.ProgramDoc
import com.pont.card.core.ProgramMath
import com.pont.card.core.ProgramState
import com.pont.card.core.PublicCard
import com.pont.card.core.earnedOn
import com.pont.card.core.earnedOnDays
import com.pont.card.core.stillAhead
import java.time.LocalDate
import java.time.LocalTime

/** The program: the points on top, then the Plan and Pulse tabs and the days. */
@Composable
fun ProgramScreen(
    state: ProgramState, card: PublicCard?, onRefresh: () -> Unit,
    onLike: (String) -> Unit, onPlace: (String, Placement) -> Unit, onRemove: (String) -> Unit,
    onSkip: (String) -> Unit = {}, onUnskipAll: () -> Unit = {},
) {
    val p = palette
    val doc = state.doc
    Column(Modifier.fillMaxSize().background(p.bg).statusBarsPadding()) {
        if (doc == null || doc.days.isEmpty()) { NoProgram(state.loading, state.offline, state.problem, onRefresh); return@Column }
        Loaded(doc, state, card, onRefresh, onLike, onPlace, onRemove, onSkip, onUnskipAll)
    }
}

@Composable
private fun NoProgram(loading: Boolean, offline: Boolean, problem: String?, onRefresh: () -> Unit) {
    val p = palette
    Column(Modifier.fillMaxSize().padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text("Program", style = Type.display(30), color = p.ink)
        Text(
            when { loading -> "Loading the program…"; offline -> "Can't reach the server. The program loads when you are online."; problem != null -> problem; else -> "There is no program yet." },
            color = p.ink2, fontSize = 17.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(vertical = 12.dp),
        )
        if (!loading) SoftButton("Try again", onClick = onRefresh)
    }
}

@Composable
private fun Loaded(
    doc: ProgramDoc, state: ProgramState, card: PublicCard?, onRefresh: () -> Unit,
    onLike: (String) -> Unit, onPlace: (String, Placement) -> Unit, onRemove: (String) -> Unit, onSkip: (String) -> Unit, onUnskipAll: () -> Unit,
) {
    val p = palette
    val clock by rememberClock()
    val today = clock.first
    var tab by rememberSaveable { mutableIntStateOf(0) }                 // 0 Plan, 1 Pulse
    var dayKey by rememberSaveable { mutableStateOf<String?>(null) }
    var queueAll by rememberSaveable { mutableStateOf(false) }
    var idx by rememberSaveable { mutableIntStateOf(0) }
    var selId by rememberSaveable { mutableStateOf<String?>(null) }
    var pulseT by rememberSaveable { mutableStateOf<Int?>(null) }
    var sheetId by rememberSaveable { mutableStateOf<String?>(null) }
    var liveStay by remember { mutableStateOf<Pair<String, Placement>?>(null) }

    val day: ProgramDay = doc.days.firstOrNull { it.key == dayKey } ?: doc.days.firstOrNull { it.date == today } ?: doc.days.first()
    val nowMin = if (day.date == today) clock.second else null
    val (d0, _) = ProgramMath.domain(state.eventsOn(day.key))
    val following = pulseT == null && nowMin != null          // Pulse follows the real time until you drag it
    val t = pulseT ?: nowMin ?: ((d0 + 100) / 5 * 5)
    val live = tab == 1

    // What the card has earned on the days of the program, and what the plan can still add. A stay being dragged counts as it is dragged.
    // Stays that are over do not count: attended ones are already in "earned", missed ones earn nothing.
    fun effective(id: String, at: Placement) = if (liveStay?.first == id) liveStay!!.second else at
    fun plannedFor(dayKey: String?): Int = state.placed.entries.sumOf { (id, at) ->
        val e = state.event(id)
        val eff = effective(id, at)
        if (e == null || (dayKey != null && e.day != dayKey) || !stillAhead(doc.days.firstOrNull { it.key == e.day }, eff, today, clock.second)) 0 else ProgramMath.earn(e, eff.dur)
    }
    val plannedAll = plannedFor(null)
    val goalDay = doc.days.firstOrNull { it.key == doc.goal.dayKey }
    val plannedGoalDay = plannedFor(doc.goal.dayKey)
    val got = if (card != null) earnedOnDays(card.history, doc.days) else 0
    val gotGoalDay = if (card != null && goalDay != null) earnedOn(card.history, goalDay.date) else 0

    Column(Modifier.fillMaxSize()) {
        StatusCard(live, got, gotGoalDay, if (live) 0 else plannedAll, if (live) 0 else plannedGoalDay, doc, goalDay?.label?.substringBefore(' ') ?: "", card != null, Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp))
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Segment(listOf("Plan", "Pulse"), tab, { tab = it; sheetId = null }, Modifier.weight(1f), dark = true)
            Segment(doc.days.map { it.label.substringBefore(' ') }, doc.days.indexOf(day), { dayKey = doc.days[it].key; selId = null; idx = 0; pulseT = null }, Modifier, dark = false)
        }
        if (state.offline) Banner("Offline, showing the saved program", Tone.Warn, Modifier.padding(horizontal = 16.dp).padding(bottom = 6.dp))
        Box(Modifier.weight(1f)) {
            if (tab == 0) PlanTab(
                state, day, nowMin, queueAll, { queueAll = it }, idx, { idx = it }, selId, { selId = it },
                onPlace, { id -> onRemove(id); liveStay = null }, { id, at -> liveStay = if (at == null) null else id to at },
                onLike, { sheetId = it }, onSkip, onUnskipAll,
            ) else PulseTab(state, day, t, nowMin, following, { pulseT = it }, { pulseT = null }, { sheetId = it }, onLike)
        }
    }

    sheetId?.let { id ->
        val e = state.event(id)
        if (e == null) sheetId = null else {
            val planned = state.placed[id]
            val snap = ProgramMath.snapFor(ProgramMath.domain(state.eventsOn(e.day)).let { it.second - it.first })
            val today2 = doc.days.firstOrNull { it.key == e.day }?.date == today
            val want = if (today2 && clock.second in e.s until e.e) clock.second else e.s
            val fit = ProgramMath.fitAt(e, want, ProgramMath.defaultDur(e), state.placedOn(e.day).filter { it.event.id != id }.map { it.at }, snap)
            EventSheet(
                e, id in state.likes, planned, fit, onLike = { onLike(id) },
                onAdd = { if (fit != null) { onPlace(id, fit); dayKey = e.day; selId = id; tab = 0; sheetId = null } },
                onShowPlan = { dayKey = e.day; selId = id; tab = 0; sheetId = null },
                onDismiss = { sheetId = null },
            )
        }
    }
}

/** The date and the minute of the day, renewed at the start of every minute, so what shows "now" never goes stale. */
@Composable
private fun rememberClock(): State<Pair<String, Int>> = produceState(initialValue = clockNow()) {
    while (true) {
        val now = LocalTime.now()
        delay(60_000L - (now.second * 1000L + now.nano / 1_000_000L) + 50L)
        value = clockNow()
    }
}

private fun clockNow(): Pair<String, Int> = LocalDate.now().toString() to LocalTime.now().let { it.hour * 60 + it.minute }

/** The points on top. On Plan: what you would have with your plan. On Pulse: what the card has really earned so far. */
@Composable
private fun StatusCard(live: Boolean, got: Int, gotDay: Int, planned: Int, plannedDay: Int, doc: ProgramDoc, dayName: String, hasCard: Boolean, modifier: Modifier) {
    val p = palette
    val goal = doc.goal
    val total = got + planned
    val dayTotal = gotDay + plannedDay
    Row(modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(16.dp)).padding(horizontal = 12.dp, vertical = 9.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        StatusColumn(
            if (live) "Earned so far" else "With your plan", "need ${goal.total}", total,
            if (live) "points" else "= $got + $planned", goal.total - total, got, planned, goal.total, Modifier.weight(1f),
        )
        StatusColumn(
            if (live) "$dayName so far" else "$dayName with plan", "need ${goal.dayMin}", dayTotal,
            if (live) "points" else "= $gotDay + $plannedDay", goal.dayMin - dayTotal, gotDay, plannedDay, goal.dayMin, Modifier.weight(1f),
        )
    }
    if (live && !hasCard) Text("Add your card to see your points.", color = p.ink3, fontSize = 12.sp, modifier = Modifier.padding(start = 20.dp, top = 4.dp))
}

@Composable
private fun StatusColumn(title: String, need: String, value: Int, detail: String, missing: Int, got: Int, planned: Int, goal: Int, modifier: Modifier) {
    val p = palette
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(title, color = p.ink2, fontSize = 11.sp, fontWeight = FontWeight.Bold, maxLines = 1)
            Text(need, color = p.ink2, fontSize = 11.sp, fontWeight = FontWeight.Bold, maxLines = 1)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Bottom) {
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("$value", color = p.ink, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp)
                Text(detail, color = p.ink3, fontWeight = FontWeight.Bold, fontSize = 11.sp, maxLines = 1)
            }
            Text(if (missing <= 0) "OK" else "$missing short", color = if (missing <= 0) p.green else p.red, fontWeight = FontWeight.ExtraBold, fontSize = 12.sp, maxLines = 1)
        }
        Meter(got, planned, goal)
    }
}

/** A row of choices, one picked. [dark] picks the strong style for the main switch. */
@Composable
private fun Segment(labels: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier, dark: Boolean) {
    val p = palette
    Row(modifier.clip(RoundedCornerShape(50)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(50)).padding(3.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        labels.forEachIndexed { i, label ->
            val on = i == selected
            Box(
                Modifier.weight(if (dark) 1f else 0.0001f, fill = dark).clip(RoundedCornerShape(50))
                    .background(if (on) (if (dark) p.ink else p.amber) else p.surface)
                    .clickable(role = Role.Tab) { onSelect(i) }.padding(horizontal = if (dark) 8.dp else 11.dp, vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, color = if (on) (if (dark) p.bg else Color12202B) else p.ink2, fontWeight = FontWeight.ExtraBold, fontSize = 14.sp, maxLines = 1)
            }
        }
    }
}

private val Color12202B = androidx.compose.ui.graphics.Color(0xFF12202B)
