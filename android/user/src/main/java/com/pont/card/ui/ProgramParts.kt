package com.pont.card.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pont.card.core.Placement
import com.pont.card.core.ProgramEvent
import com.pont.card.core.ProgramMath
import com.pont.card.core.duration
import com.pont.card.core.hm
import com.pont.card.core.range

/** The colours of an event's kind of points: the text and line colour, and the soft fill. */
data class KindColors(val fg: Color, val bg: Color)

@Composable
fun kindColors(kind: String): KindColors {
    val p = palette
    return when (kind) {
        "time" -> KindColors(p.green, p.greenSoft)
        "mix" -> KindColors(p.mix, p.mixSoft)
        else -> KindColors(p.amberInk, p.amberSoft)
    }
}

fun kindLabel(kind: String) = when (kind) { "time" -> "Points per time"; "mix" -> "Mixed"; else -> "Points per task" }

@Composable
fun KindChip(event: ProgramEvent, modifier: Modifier = Modifier) {
    val c = kindColors(event.kindKey)
    Text(
        kindLabel(event.kindKey), color = c.fg, fontWeight = FontWeight.Bold, fontSize = 12.sp,
        modifier = modifier.clip(RoundedCornerShape(50)).background(c.bg).padding(horizontal = 10.dp, vertical = 3.dp),
    )
}

/** The round like button. */
@Composable
fun HeartButton(liked: Boolean, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val p = palette
    Box(
        modifier.size(40.dp).clip(CircleShape).background(if (liked) p.redSoft else p.surface)
            .border(if (liked) 0.dp else 1.5.dp, p.line, CircleShape)
            .clickable(role = Role.Button, onClick = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { Text(if (liked) "♥" else "♡", color = if (liked) p.red else p.ink3, fontSize = 20.sp) }
}

/** A bar toward a goal: dark for what the card has, green for what is planned on top of it, and a marker at the goal. */
@Composable
fun Meter(got: Int, planned: Int, goal: Int, modifier: Modifier = Modifier) {
    val p = palette
    val total = goal.coerceAtLeast(1).toFloat()
    val a = (got / total).coerceIn(0f, 1f)
    val b = ((got + planned) / total).coerceIn(0f, 1f)
    Box(modifier.fillMaxWidth().height(9.dp).clip(RoundedCornerShape(5.dp)).background(p.line)) {
        Row(Modifier.fillMaxHeight()) {
            if (a > 0f) Box(Modifier.fillMaxHeight().weight(a).background(p.ink))
            if (b - a > 0f) Box(Modifier.fillMaxHeight().weight(b - a).background(p.green))
            if (1f - b > 0f) Spacer(Modifier.weight(1f - b))
        }
    }
}

/** A row of "label ... value" lines of the sheet. */
@Composable
private fun Fact(label: String, value: String, modifier: Modifier) {
    val p = palette
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(p.bg).padding(horizontal = 10.dp, vertical = 8.dp)) {
        Text(label.uppercase(), color = p.ink3, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp)
        Text(value, color = p.ink, fontWeight = FontWeight.Bold, fontSize = 15.sp)
    }
}

/**
 * Everything about one event, with Like and "Add to my day". [planned] is where it already is in the plan, [fit] where it would go now
 * (null when the day has no room for it).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EventSheet(
    event: ProgramEvent, liked: Boolean, planned: Placement?, fit: Placement?,
    onLike: () -> Unit, onAdd: () -> Unit, onShowPlan: () -> Unit, onDismiss: () -> Unit,
) {
    val p = palette
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = p.surface) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 16.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            KindChip(event)
            Text(event.title, style = Type.display(24), color = p.ink)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Fact("When", event.range(), Modifier.weight(1f)); Fact("Where", event.room, Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Fact("First hour", "${ProgramMath.perHour(event)} points", Modifier.weight(1f))
                Fact("Everything", "${ProgramMath.maxPts(event)} points", Modifier.weight(1f))
            }
            val rule = listOf(event.rule, if (event.bonus.isNotBlank()) "Bonus: ${event.bonus}." else "", event.note).filter { it.isNotBlank() }.joinToString(" ")
            if (rule.isNotBlank()) Text(rule, color = p.ink2, fontSize = 15.sp)
            if (event.model == "tasks" && event.items.size > 1) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    event.items.forEach { t ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(t.name, color = p.ink2, fontSize = 14.sp, modifier = Modifier.weight(1f))
                            Text("${t.pts} p · ~${t.min} min", color = p.ink, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                        }
                    }
                    event.home.forEach { t ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(t.name, color = p.ink2, fontSize = 14.sp, modifier = Modifier.weight(1f))
                            Text("${t.pts} p", color = p.ink, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                        }
                    }
                }
                Text("The minutes per task are a guess, so the plan can show points for a stay.", color = p.ink3, fontSize = 12.sp)
            }
            if (event.bring.isNotBlank()) Text("Bring: ${event.bring}", color = p.ink2, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            if (event.check.isNotBlank()) Banner("Check: ${event.check}", Tone.Warn)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                Box(
                    Modifier.weight(1f).heightIn(min = 48.dp).clip(RoundedCornerShape(14.dp)).background(if (liked) p.redSoft else p.bg)
                        .clickable(role = Role.Button, onClick = onLike), contentAlignment = Alignment.Center,
                ) { Text(if (liked) "♥ Liked" else "♡ Like", color = if (liked) p.red else p.ink, fontWeight = FontWeight.Bold) }
                val enabled = planned != null || fit != null
                Box(
                    Modifier.weight(1.6f).heightIn(min = 48.dp).clip(RoundedCornerShape(14.dp)).background(if (enabled) p.green else p.line)
                        .clickable(enabled = enabled, role = Role.Button) { if (planned != null) onShowPlan() else onAdd() },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        when { planned != null -> "In your plan at ${hm(planned.start)}"; fit != null -> "Add to my day at ${hm(fit.start)}"; else -> "No room in your day" },
                        color = if (enabled) p.onGreen else p.ink3, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 8.dp),
                    )
                }
            }
        }
    }
}

/** "09:00–09:36 · 36 min" for a planned stay. */
fun stayText(at: Placement): String = "${hm(at.start)}–${hm(at.end)} · ${duration(at.dur)}"
