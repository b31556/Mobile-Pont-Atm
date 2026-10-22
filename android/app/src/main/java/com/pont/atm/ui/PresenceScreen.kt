package com.pont.atm.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pont.atm.core.PontApi
import com.pont.atm.core.PresenceOutcome
import com.pont.atm.core.PresenceResult
import com.pont.atm.core.PresenceState
import com.pont.atm.core.formatTime

private val Amber = Color(0xFFB7791F)

/** Words for a check-in tap that did not sign anyone in or out. */
fun presenceRefusalCopy(outcome: PresenceOutcome): OutcomeCopy? = when (outcome) {
    is PresenceOutcome.Done -> null
    is PresenceOutcome.Blocked -> OutcomeCopy("Card is blocked", "Ask an admin to unblock it.")
    PresenceOutcome.UnknownCard -> OutcomeCopy("Card not registered", "An admin has been told about this card and can add it.")
    PresenceOutcome.NoConnection -> OutcomeCopy("No connection", "Tap again. The card may already have been signed in or out.")
    PresenceOutcome.WrongMode -> OutcomeCopy("Not ready yet", "An admin just changed this phone's mode. Try again in a moment.")
    is PresenceOutcome.Failed -> OutcomeCopy("Couldn't sign you in or out", "${outcome.message} Tap again.")
}

/** One line for what happened to the daily allowance, or null if nothing to say. */
fun limitNote(r: PresenceResult): String? = when (r.cappedBy) {
    "visit" -> "Visit limit reached: ${r.raw} points would have been earned."
    "24h" -> if (r.points == 0) "Daily limit reached. No more points for now." else "Daily limit reached: ${r.raw} points would have been earned."
    else -> null
}

/**
 * The check-in terminal: no buttons. It waits for a card, shows what the tap did, and goes back to waiting.
 * The terminal name at the bottom opens the menu with a long press (unpair, beep on or off).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun PresenceScreen(state: PresenceState, api: PontApi, terminal: String, direction: String, zoneName: String?, onMenu: () -> Unit, onDebugTag: (String) -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (state) {
                PresenceState.Idle, is PresenceState.Sending -> Waiting(sending = state is PresenceState.Sending, title = idleTitle(direction), zoneName = zoneName, onDebugTag = onDebugTag)
                is PresenceState.Showing -> when (val o = state.outcome) {
                    is PresenceOutcome.Done -> Visit(o.result, api)
                    is PresenceOutcome.Blocked -> Refused(presenceRefusalCopy(o)!!, o.name, o.photoUrl, api)
                    else -> Refused(presenceRefusalCopy(o)!!, null, null, api)
                }
            }
        }
        Text(
            terminal, color = if (state is PresenceState.Showing) PontColors.Ink3 else Muted, fontSize = 13.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().combinedClickable(onClick = {}, onLongClick = onMenu).padding(vertical = 18.dp),
        )
    }
}

@Composable
private fun Waiting(sending: Boolean, title: String, zoneName: String?, onDebugTag: (String) -> Unit) {
    Column(Modifier.fillMaxSize().padding(horizontal = 28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(if (sending) "One moment…" else title, style = PontType.display(36), color = Color.White, textAlign = TextAlign.Center)
        if (zoneName != null) Text(zoneName, color = Muted, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 6.dp))
        Rings(Modifier.padding(vertical = 40.dp))
        DebugTapButtons(onDebugTag)
    }
}

@Composable
private fun Visit(r: PresenceResult, api: PontApi) {
    val copy = visitCopy(r)
    val color = when (copy.tone) { Tone.Good -> PontColors.Green; Tone.Neutral -> PontColors.Ink2; Tone.Warn -> Amber }
    Column(Modifier.fillMaxSize()) {
        Header(color) {
            Text(copy.title, style = PontType.display(30), color = Color.White)
            if (r.action == "out") {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(if (r.points > 0) "+${r.points}" else "0", style = PontType.display(54), color = Color.White)
                    Text(if (r.points == 1) "point" else "points", color = Color(0xD9FFFFFF), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 6.dp, bottom = 8.dp))
                }
            }
        }
        Column(Modifier.fillMaxWidth().padding(top = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Avatar(api, r.card.photoUrl, r.card.name, 148.dp, ring = color)
            Text(r.card.name, style = PontType.display(26), modifier = Modifier.padding(top = 14.dp), textAlign = TextAlign.Center)
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(top = 14.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            copy.notes.forEach { note ->
                when {
                    note.startsWith("Balance:") -> Line(note, strong = r.action == "out")
                    note.contains("earned no points") || note.endsWith("points would have been earned.") || note.startsWith("Daily limit") ->
                        Text(note, color = Amber, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
                    else -> Line(note)
                }
            }
        }
    }
}

@Composable
private fun Line(text: String, strong: Boolean = false) {
    Text(text, color = if (strong) PontColors.Ink else PontColors.Ink2, fontWeight = if (strong) FontWeight.Bold else FontWeight.Medium, fontSize = 16.sp, textAlign = TextAlign.Center)
}

@Composable
private fun Refused(copy: OutcomeCopy, holder: String?, photo: String?, api: PontApi) {
    Column(Modifier.fillMaxSize()) {
        Header(PontColors.Red) {
            Text("✕", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 36.sp)
            Text(copy.title, style = PontType.display(30), color = Color.White, textAlign = TextAlign.Center)
        }
        Column(Modifier.fillMaxWidth().padding(top = 22.dp, start = 24.dp, end = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (holder != null) {
                Avatar(api, photo.orEmpty(), holder, 148.dp, ring = PontColors.Red)
                Text(holder, style = PontType.display(26), modifier = Modifier.padding(top = 14.dp))
            }
            Spacer(Modifier.padding(top = 6.dp))
            Text(copy.message, color = PontColors.Ink2, textAlign = TextAlign.Center, fontSize = 16.sp)
        }
    }
}

/** "47 min" or "2 h 5 min". */
fun duration(minutes: Int): String = when {
    minutes < 60 -> "$minutes min"
    minutes % 60 == 0 -> "${minutes / 60} h"
    else -> "${minutes / 60} h ${minutes % 60} min"
}
