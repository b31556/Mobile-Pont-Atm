package com.pont.atm.ui

import com.pont.atm.core.InfoOutcome
import com.pont.atm.core.InfoRow
import com.pont.atm.core.formatTime
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** How long an info result stays on screen before the phone goes back to "Tap a card to see its points". */
const val INFO_SHOW_MS = 8_000L

/** Words for an info tap that did not return a card, or null for a success. */
fun infoRefusalCopy(outcome: InfoOutcome): OutcomeCopy? = when (outcome) {
    is InfoOutcome.Done -> null
    is InfoOutcome.Blocked -> OutcomeCopy("Card is blocked", "Ask an admin to unblock it.")
    InfoOutcome.UnknownCard -> OutcomeCopy("Card not registered", "This card isn't in the system.")
    InfoOutcome.NoConnection -> OutcomeCopy("No connection", "Tap again in a moment.")
    InfoOutcome.WrongMode -> OutcomeCopy("Not ready yet", "An admin just changed this phone's mode. Try again in a moment.")
    is InfoOutcome.Failed -> OutcomeCopy("Couldn't look up the card", "${outcome.message} Tap again.")
}

/** A success is the soft rising pair; anything else is the three low beeps, like the other modes. */
fun infoSucceeded(outcome: InfoOutcome): Boolean = outcome is InfoOutcome.Done

/** What a history row is called on the kiosk. [Reversed] rows were undone later by a storno. */
data class InfoRowCopy(val title: String, val detail: String?, val reversed: Boolean)

fun infoRowCopy(row: InfoRow): InfoRowCopy {
    val place = row.place.trim().ifEmpty { null }
    val note = row.note?.trim()?.ifEmpty { null }
    val (title, detail) = when (row.kind) {
        "atm", "fixed" -> "Points received" to place
        "presence" -> "Check-out" to listOfNotNull(place, note).joinToString(" · ").ifEmpty { null }
        "storno" -> "Refund" to listOfNotNull(place, note).joinToString(" · ").ifEmpty { null }
        "adjust" -> "Adjustment" to note
        else -> "Transaction" to place
    }
    return InfoRowCopy(title, detail, row.stornoed)
}

/** "+8", "−3" or "0": the amount with its sign. */
fun signedAmount(amount: Int): String = when {
    amount > 0 -> "+$amount"
    amount < 0 -> "−${-amount}"
    else -> "0"
}

private val dayMonth = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)

/** "14:32" for a row from today, "30 Oct 14:32" for an older one. */
fun infoRowTime(iso: String, today: LocalDate = LocalDate.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val at = runCatching { Instant.parse(iso).atZone(zone) }.getOrNull() ?: return "–"
    val time = formatTime(iso, zone)
    return if (at.toLocalDate() == today) time else "${dayMonth.format(at)} $time"
}
