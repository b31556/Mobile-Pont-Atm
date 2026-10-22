package com.pont.atm.ui

import com.pont.atm.core.PresenceOutcome
import com.pont.atm.core.PresenceResult
import com.pont.atm.core.formatTime
import java.time.ZoneId

enum class Tone { Good, Neutral, Warn }

/** The title, colour and lines the check-in screen shows for a tap that reached the server. */
data class VisitCopy(val title: String, val tone: Tone, val notes: List<String>)

fun visitCopy(r: PresenceResult, zone: ZoneId = ZoneId.systemDefault()): VisitCopy {
    fun time(iso: String?) = if (iso == null) "–" else formatTime(iso, zone)
    val zoneLine = r.zone?.let { "Zone: ${it.name}" }
    val balance = "Balance: ${r.card.balance} points"
    val today = "Today: ${r.today.earned}${r.today.max?.let { " of $it" }.orEmpty()} points"
    return when (r.action) {
        "in" -> VisitCopy("Checked in", Tone.Good, listOfNotNull("Since ${time(r.inAt)}", zoneLine, today, balance))
        "out" -> VisitCopy("Checked out", Tone.Good, listOfNotNull(
            "Inside ${duration(r.minutes ?: 0)}  \u00b7  ${time(r.inAt)} to ${time(r.outAt)}", limitNote(r), zoneLine, today, balance,
        ))
        "already_in" -> VisitCopy("Already checked in", Tone.Neutral, listOf(
            "Since ${time(r.inAt)}${r.zone?.let { " in ${it.name}" }.orEmpty()}", "Use a sign-out point to check out.", balance,
        ))
        "not_in" -> VisitCopy("Not checked in", Tone.Warn, listOf("Check in at a sign-in point first.", balance))
        "expired_out" -> VisitCopy("Checked out", Tone.Warn, listOf("Your last visit wasn't signed out in time, so it earned no points.", balance))
        "expired_in" -> VisitCopy("Checked in", Tone.Warn, listOfNotNull(
            "Since ${time(r.inAt)}", zoneLine, "Your last visit wasn't signed out, so it earned no points.", balance,
        ))
        else -> VisitCopy("Already checked in", Tone.Neutral, listOf("Since ${time(r.inAt)}. You were just checked in.", balance))
    }
}

enum class PresenceSound { CheckIn, Success, Refusal }

/** Signing out is the rising pair, signing in or a quiet no-change is one soft beep, anything that didn't work is the three low beeps. */
fun presenceSound(o: PresenceOutcome): PresenceSound = when (o) {
    is PresenceOutcome.Done -> when (o.result.action) {
        "out" -> PresenceSound.Success
        "in", "cooldown", "expired_in", "expired_out" -> PresenceSound.CheckIn
        else -> PresenceSound.Refusal
    }
    else -> PresenceSound.Refusal
}

/** What the waiting screen says, by what this point does. */
fun idleTitle(direction: String): String = when (direction) {
    "in" -> "Tap to sign in"
    "out" -> "Tap to sign out"
    else -> "Tap your card"
}
