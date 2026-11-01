package com.pont.card.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The rows of one calendar day in the phone's time zone; [day] is null for rows whose time can't be read. */
data class DayGroup(val day: LocalDate?, val entries: List<HistoryEntry>)

private fun instantOf(iso: String): Instant? = runCatching { Instant.parse(iso) }.getOrNull()

/** Newest first, grouped by local calendar day. Rows with an unreadable time go last, in their own group. */
fun groupByDay(entries: List<HistoryEntry>, zone: ZoneId = ZoneId.systemDefault()): List<DayGroup> {
    val (readable, unreadable) = entries.partition { instantOf(it.at) != null }
    val groups = readable.sortedByDescending { instantOf(it.at) }
        .groupBy { instantOf(it.at)!!.atZone(zone).toLocalDate() }
        .map { (day, rows) -> DayGroup(day, rows) }
    return if (unreadable.isEmpty()) groups else groups + DayGroup(null, unreadable)
}

private val longDay = DateTimeFormatter.ofPattern("EEEE, d MMMM", Locale.ENGLISH)
private val longDayYear = DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.ENGLISH)
private val hm = DateTimeFormatter.ofPattern("HH:mm", Locale.ENGLISH)

/** "Today", "Yesterday", then "Friday, 30 October" (with the year when it isn't this year). */
fun dayHeading(day: LocalDate?, today: LocalDate = LocalDate.now()): String = when {
    day == null -> "Unknown date"
    day == today -> "Today"
    day == today.minusDays(1) -> "Yesterday"
    day.year == today.year -> longDay.format(day)
    else -> longDayYear.format(day)
}

/** "14:32" in the phone's time zone; "–" if the time can't be read. */
fun timeOfDay(iso: String, zone: ZoneId = ZoneId.systemDefault()): String =
    instantOf(iso)?.let { hm.format(it.atZone(zone)) } ?: "–"

enum class RowKind { Received, CheckOut, Refund, Adjustment, Other }
enum class Sign { Plus, Minus, Zero }

/** What a history row says. [amount] is the signed number ("+8", "−3"); [reversed] rows were undone by a storno. */
data class RowCopy(val title: String, val detail: String?, val kind: RowKind, val reversed: Boolean, val amount: String, val sign: Sign)

fun rowCopy(e: HistoryEntry): RowCopy {
    val place = e.place.trim().ifEmpty { null }
    val note = e.note?.trim()?.ifEmpty { null }
    val both = listOfNotNull(place, note).joinToString(" · ").ifEmpty { null }
    val (kind, title, detail) = when (e.kind) {
        "atm", "fixed" -> Triple(RowKind.Received, "Points received", place)
        "presence" -> Triple(RowKind.CheckOut, "Check-out", both)
        "storno" -> Triple(RowKind.Refund, "Refund", both)
        "adjust" -> Triple(RowKind.Adjustment, "Adjustment", note)
        else -> Triple(RowKind.Other, "Transaction", place)
    }
    val sign = when { e.amount > 0 -> Sign.Plus; e.amount < 0 -> Sign.Minus; else -> Sign.Zero }
    return RowCopy(title, detail, kind, e.stornoed, signedAmount(e.amount), sign)
}

/** "+8", "−3" (a real minus sign) or "0". */
fun signedAmount(amount: Int): String = when {
    amount > 0 -> "+$amount"
    amount < 0 -> "−${-amount}"
    else -> "0"
}
