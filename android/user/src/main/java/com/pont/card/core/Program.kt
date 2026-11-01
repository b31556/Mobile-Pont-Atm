package com.pont.card.core

import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/* The event program as the server sends it (GET /public/program), and the maths on it: what staying a while is worth, and where a stay fits. */

@Serializable data class ProgramDay(val key: String, val label: String, val date: String)

@Serializable data class ProgramGoal(val total: Int = 0, val dayKey: String = "", val dayMin: Int = 0)

@Serializable data class TaskItem(val name: String, val pts: Int, val min: Int)

@Serializable data class HomeTask(val name: String, val pts: Int)

/** One thing to do. `model` is "rate" (points per block of minutes), "tasks" (a list of items) or "flat" (an award for staying to the end). */
@Serializable data class ProgramEvent(
    val id: String,
    val day: String,
    val title: String,
    val room: String = "",
    val from: String,
    val to: String,
    val model: String = "flat",
    val rate: Int = 0,
    val block: Int = 0,
    val cap: Int? = null,
    val maxMin: Int? = null,
    val items: List<TaskItem> = emptyList(),
    val home: List<HomeTask> = emptyList(),
    val kind: String? = null,
    val rule: String = "",
    val bonus: String = "",
    val bring: String = "",
    val note: String = "",
    val check: String = "",
) {
    /** Start and end as minutes since midnight. */
    val s: Int get() = clock(from)
    val e: Int get() = clock(to)
    val window: Int get() = e - s
    /** Runs all morning (4 hours or more): go whenever you like. Shorter ones have fixed hours. */
    val open: Boolean get() = window >= 240
    /** "time", "task" or "mix": what the colour of the event says about how it scores. */
    val kindKey: String get() = kind ?: when (model) { "rate" -> "time"; "flat" -> "mix"; else -> "task" }
}

@Serializable data class ProgramDoc(
    val title: String = "",
    val days: List<ProgramDay> = emptyList(),
    val goal: ProgramGoal = ProgramGoal(),
    val events: List<ProgramEvent> = emptyList(),
    val updatedAt: String = "",
)

/** "08:30" as 510. A bad time is 0. */
fun clock(text: String): Int {
    val p = text.split(':')
    return (p.getOrNull(0)?.toIntOrNull() ?: 0) * 60 + (p.getOrNull(1)?.toIntOrNull() ?: 0)
}

fun hm(minutes: Int): String = "%02d:%02d".format(minutes / 60, minutes % 60)

fun ProgramEvent.range(): String = "${hm(s)}–${hm(e)}"

/** "1 h 10 min", "45 min". */
fun duration(minutes: Int): String =
    if (minutes >= 60) "${minutes / 60} h" + (if (minutes % 60 != 0) " ${minutes % 60} min" else "") else "$minutes min"

/** A stay: from [start] for [dur] minutes, both in minutes since midnight. */
data class Placement(val start: Int, val dur: Int) { val end: Int get() = start + dur }

/** A stay in the plan, with its event. */
data class Placed(val event: ProgramEvent, val at: Placement)

object ProgramMath {
    /** The points for staying [minutes] at [e]. */
    fun earn(e: ProgramEvent, minutes: Int): Int = when (e.model) {
        "flat" -> if (minutes >= e.window) e.cap ?: 0 else 0
        "rate" -> {
            val d = min(minutes, e.maxMin ?: Int.MAX_VALUE)
            val blocks = if (e.block > 0) d / e.block else 0
            min(blocks * e.rate, e.cap ?: Int.MAX_VALUE)
        }
        else -> {
            // tasks: the best points per minute first; the last one counts for the share of it that fits
            var left = minutes.toDouble()
            var pts = 0.0
            for (t in e.items.filter { it.min > 0 }.sortedByDescending { it.pts.toDouble() / it.min }) {
                val take = min(1.0, left / t.min)
                if (take <= 0.0) break
                pts += t.pts * take
                left -= t.min * take
            }
            floor(pts + 1e-9).toInt()
        }
    }

    /** Everything the event gives for a stay of its whole length. */
    fun maxPts(e: ProgramEvent): Int = earn(e, e.window)

    /** What the first hour is worth, to compare events. */
    fun perHour(e: ProgramEvent): Int = earn(e, min(60, e.window))

    /** The stay a card is dropped with: what an hour earns, or everything there is. */
    fun defaultDur(e: ProgramEvent): Int = when (e.model) {
        "flat" -> e.window
        "rate" -> {
            val cap = e.cap?.let { if (e.rate > 0) ceil(it.toDouble() / e.rate).toInt() * e.block else Int.MAX_VALUE } ?: Int.MAX_VALUE
            min(min(e.window, min(e.maxMin ?: 60, 60)), cap)
        }
        else -> min(min(e.window, e.items.sumOf { it.min }), 60)
    }

    /** Minutes more to stay for the next points, or null when staying longer earns nothing more. */
    fun nextStep(e: ProgramEvent, d: Int): Int? {
        when (e.model) {
            "rate" -> {
                if (e.block <= 0 || d >= (e.maxMin ?: Int.MAX_VALUE) || earn(e, d) >= (e.cap ?: Int.MAX_VALUE)) return null
                return e.block - (d % e.block)
            }
            "tasks" -> {
                val now = earn(e, d)
                for (k in d + 1..e.window) if (earn(e, k) > now) return k - d
            }
        }
        return null
    }

    /** Free stretches of [from]..[to] once the stays of [others] are taken out. */
    fun freeParts(from: Int, to: Int, others: List<Placement>): List<Pair<Int, Int>> {
        var parts = listOf(from to to)
        for (o in others) {
            parts = parts.flatMap { (a, b) ->
                val s = max(a, o.start)
                val e = min(b, o.end)
                if (e <= s) listOf(a to b) else listOf(a to s, e to b).filter { it.second > it.first }
            }
        }
        return parts
    }

    /** The grid dragging snaps to: 5 minutes, or 15 on a long day. */
    fun snapFor(domainMinutes: Int): Int = if (domainMinutes > 300) 15 else 5

    /**
     * The nearest legal place for a stay of [d] minutes wanted at [want]: inside the event's hours, clear of [others], on the [snap] grid.
     * It shrinks to fit a smaller gap (but a fixed award must keep its whole length). Null when nothing fits.
     */
    fun fitAt(e: ProgramEvent, want: Int, d: Int, others: List<Placement>, snap: Int): Placement? {
        val g = snap
        val parts = freeParts(e.s, e.e, others)
            .map { (a, b) -> ((a + g - 1) / g) * g to (b / g) * g }
            .filter { it.second - it.first >= g }
        var best: Placement? = null
        var bestCost = Int.MAX_VALUE
        for ((a, b) in parts) {
            val len = min(d, b - a)
            if (len < g || (len < d && e.model == "flat")) continue
            val start = Math.round(min(max(want, a), b - len).toDouble() / g).toInt() * g
            val cost = kotlin.math.abs(start - want) + (d - len) * 2
            if (cost < bestCost) { bestCost = cost; best = Placement(start, len) }
        }
        return best
    }

    /** Hours of the day shown on a line: whole hours around the events of the day. */
    fun domain(events: List<ProgramEvent>): Pair<Int, Int> =
        if (events.isEmpty()) 480 to 720 else (events.minOf { it.s } / 60) * 60 to ((events.maxOf { it.e } + 59) / 60) * 60
}

/** Points the card has earned on a day, from its history. Stornoed rows and the storno rows cancel out, so neither is counted. */
fun earnedOn(history: List<HistoryEntry>, date: String, zone: ZoneId = ZoneId.systemDefault()): Int {
    val day = runCatching { LocalDate.parse(date) }.getOrNull() ?: return 0
    val sum = history.filter { !it.stornoed && it.kind != "storno" }.sumOf {
        val at = runCatching { Instant.parse(it.at).atZone(zone).toLocalDate() }.getOrNull()
        if (at == day) it.amount else 0
    }
    return max(0, sum)
}

/** Points the card earned on the days of the program. This is the "earned so far": the card's whole balance would also count points from elsewhere. */
fun earnedOnDays(history: List<HistoryEntry>, days: List<ProgramDay>, zone: ZoneId = ZoneId.systemDefault()): Int =
    days.sumOf { earnedOn(history, it.date, zone) }

/**
 * Whether a planned stay can still add points: its day is in the future, or it is today and the stay has not ended yet.
 * A stay that is over was either attended (its points are already in what the card earned) or missed, so it must not count again.
 * [today] is "2026-10-22", [nowMin] the minute of the day.
 */
fun stillAhead(day: ProgramDay?, at: Placement, today: String, nowMin: Int): Boolean = when {
    day == null -> false
    day.date > today -> true
    day.date == today -> at.end > nowMin
    else -> false
}

/** Short names for the day switch: the first word of each label ("Thu", "Wednesday"), or the whole labels when the first words would be the same ("Day 1", "Day 2"). */
fun shortDayLabels(days: List<ProgramDay>): List<String> {
    val firsts = days.map { it.label.substringBefore(' ') }
    return if (firsts.toSet().size == firsts.size) firsts else days.map { it.label }
}
