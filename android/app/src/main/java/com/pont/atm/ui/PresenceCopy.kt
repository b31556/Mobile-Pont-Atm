package com.pont.atm.ui

import com.pont.atm.core.CancelKey
import com.pont.atm.core.CancelResult
import com.pont.atm.core.PresenceDiscarded
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

/** A sign-in that cancelled a visit elsewhere gets the warning beep. Signing out is the rising pair, signing in or a quiet no-change is one soft beep, anything that didn't work is the three low beeps. */
fun presenceSound(o: PresenceOutcome): PresenceSound = when (o) {
    is PresenceOutcome.Done -> if (o.result.discarded != null) PresenceSound.Refusal else when (o.result.action) {
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

/** How long the result of a check-in tap stays on screen before the phone goes back to "Tap your card": longer when it carries the warning about a cancelled visit. */
fun presenceShowMs(o: PresenceOutcome): Long =
    if (o is PresenceOutcome.Done && o.result.discarded != null) 8_000L else 5_000L

/** The amber warning under "Checked in" when the card was still inside at another zone. */
fun discardWarning(d: PresenceDiscarded): String {
    val where = d.zone.ifBlank { "another zone" }
    return "Still checked in at $where: that visit (${duration(d.minutes)}) was cancelled, no points for it."
}

/** What cancelling a result would cancel: `in` for a check-in, `out` for a check-out, null when there is nothing to cancel. */
fun cancelKeyOf(r: PresenceResult): CancelKey? {
    val id = r.sessionId ?: return null
    return when (r.action) { "in", "out" -> CancelKey(id, r.action); else -> null }
}

fun cancelButtonLabel(key: CancelKey): String = if (key.expect == "in") "Cancel this check-in" else "Cancel this check-out"

/** The title and question of the confirmation sheet. */
fun cancelQuestion(r: PresenceResult, key: CancelKey): OutcomeCopy {
    val name = r.card.name
    return if (key.expect == "in") {
        OutcomeCopy("Cancel this check-in?", "$name is no longer inside. No points are paid.")
    } else {
        val after = r.card.balance - r.points
        val loss = if (r.points == 0) "No points are taken back, and $name" else "$name will lose ${r.points} ${if (r.points == 1) "point" else "points"} (balance ${r.card.balance} \u2192 $after) and"
        OutcomeCopy("Cancel this check-out?", "$loss is inside again as if they had not signed out.")
    }
}

/** The header of the screen shown after a cancel went through. */
fun cancelledTitle(r: CancelResult): String = if (r.action == "cancelled_out") "Check-out cancelled" else "Check-in cancelled"

/** The lines under the name after a cancel: points taken back (check-out only) and the new balance. */
fun cancelledNotes(r: CancelResult): List<String> = listOfNotNull(
    if (r.action == "cancelled_out" && r.points > 0) "${r.points} ${if (r.points == 1) "point" else "points"} taken back" else null,
    r.zone?.let { "Zone: ${it.name}" },
    "Balance: ${r.card.balance} points",
)
