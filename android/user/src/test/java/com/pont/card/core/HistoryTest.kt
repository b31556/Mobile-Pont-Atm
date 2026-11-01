package com.pont.card.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class HistoryTest {
    private val utc = ZoneId.of("UTC")
    private fun e(at: String, kind: String = "fixed", amount: Int = 8, place: String = "Bar 2", note: String? = null, stornoed: Boolean = false) =
        HistoryEntry(at, kind, amount, place, note, stornoed)

    // ---- grouping ----

    @Test fun rowsAreGroupedByDayNewestFirst() {
        val groups = groupByDay(listOf(
            e("2026-11-01T14:20:00.000Z"), e("2026-11-01T09:00:00.000Z"), e("2026-10-31T23:30:00.000Z"), e("2026-10-29T08:00:00.000Z"),
        ), utc)
        assertEquals(listOf(LocalDate.of(2026, 11, 1), LocalDate.of(2026, 10, 31), LocalDate.of(2026, 10, 29)), groups.map { it.day })
        assertEquals(listOf(2, 1, 1), groups.map { it.entries.size })
        assertEquals("2026-11-01T14:20:00.000Z", groups[0].entries[0].at)
    }

    @Test fun anOutOfOrderListIsSorted() {
        val groups = groupByDay(listOf(e("2026-10-30T10:00:00.000Z"), e("2026-11-01T10:00:00.000Z"), e("2026-10-30T12:00:00.000Z")), utc)
        assertEquals(listOf(LocalDate.of(2026, 11, 1), LocalDate.of(2026, 10, 30)), groups.map { it.day })
        assertEquals("2026-10-30T12:00:00.000Z", groups[1].entries[0].at)
    }

    @Test fun theDayIsTheDayInThePhonesTimeZone() {
        val rows = listOf(e("2026-10-31T23:30:00.000Z"), e("2026-11-01T00:30:00.000Z"))
        assertEquals(2, groupByDay(rows, utc).size)
        // In Budapest (UTC+1 after the clocks went back) both are on 1 November.
        val budapest = groupByDay(rows, ZoneId.of("Europe/Budapest"))
        assertEquals(1, budapest.size); assertEquals(LocalDate.of(2026, 11, 1), budapest[0].day)
    }

    @Test fun unreadableTimesGoLastInTheirOwnGroup() {
        val groups = groupByDay(listOf(e("garbage"), e("2026-11-01T14:20:00.000Z")), utc)
        assertEquals(2, groups.size); assertNull(groups[1].day); assertEquals("garbage", groups[1].entries[0].at)
    }

    @Test fun noHistoryNoGroups() = assertTrue(groupByDay(emptyList(), utc).isEmpty())

    // ---- relative day ----

    private val today = LocalDate.of(2026, 11, 1)

    @Test fun todayAndYesterdayHaveNames() {
        assertEquals("Today", dayHeading(today, today)); assertEquals("Yesterday", dayHeading(today.minusDays(1), today))
    }

    @Test fun olderDaysAreDated() {
        assertEquals("Thursday, 29 October", dayHeading(LocalDate.of(2026, 10, 29), today))
        assertEquals("31 December 2025", dayHeading(LocalDate.of(2025, 12, 31), today))
    }

    @Test fun yesterdayAcrossTheEndOfAMonthAndYear() {
        assertEquals("Yesterday", dayHeading(LocalDate.of(2026, 10, 31), today))
        assertEquals("Yesterday", dayHeading(LocalDate.of(2025, 12, 31), LocalDate.of(2026, 1, 1)))
    }

    @Test fun anUnknownDayIsSaid() = assertEquals("Unknown date", dayHeading(null, today))

    @Test fun timeOfDayIsInTheGivenZone() {
        assertEquals("14:20", timeOfDay("2026-11-01T14:20:00.000Z", utc))
        assertEquals("15:20", timeOfDay("2026-11-01T14:20:00.000Z", ZoneId.of("Europe/Budapest")))
        assertEquals("–", timeOfDay("nope", utc))
    }

    // ---- row titles ----

    @Test fun pointsFromATerminalAreReceived() {
        for (k in listOf("atm", "fixed")) {
            val c = rowCopy(e("2026-11-01T14:20:00.000Z", k, 8, "Bar 2"))
            assertEquals("Points received", c.title); assertEquals("Bar 2", c.detail); assertEquals(RowKind.Received, c.kind); assertEquals("+8", c.amount); assertEquals(Sign.Plus, c.sign)
        }
    }

    @Test fun aCheckOutShowsTheDurationAndPlace() {
        val c = rowCopy(e("2026-11-01T14:20:00.000Z", "presence", 24, "Gym", "34 min"))
        assertEquals("Check-out", c.title); assertEquals("Gym · 34 min", c.detail); assertEquals(RowKind.CheckOut, c.kind)
        assertEquals("34 min", rowCopy(e("2026-11-01T14:20:00.000Z", "presence", 24, "", "34 min")).detail)
    }

    @Test fun aStornoIsARefundWithANegativeAmount() {
        val c = rowCopy(e("2026-11-01T14:20:00.000Z", "storno", -8, "Bar 2"))
        assertEquals("Refund", c.title); assertEquals("−8", c.amount); assertEquals(Sign.Minus, c.sign); assertEquals(RowKind.Refund, c.kind)
    }

    @Test fun anAdjustmentShowsItsReasonInsteadOfAPlace() {
        val c = rowCopy(e("2026-11-01T14:20:00.000Z", "adjust", -3, "", "Lost wristband"))
        assertEquals("Adjustment", c.title); assertEquals("Lost wristband", c.detail); assertEquals("−3", c.amount)
        assertNull(rowCopy(e("2026-11-01T14:20:00.000Z", "adjust", 5, "", null)).detail)
    }

    @Test fun aReversedRowIsFlaggedAndKeepsItsAmount() {
        val c = rowCopy(e("2026-11-01T14:20:00.000Z", "fixed", 8, "Bar 2", stornoed = true))
        assertTrue(c.reversed); assertEquals("+8", c.amount); assertEquals("Points received", c.title)
        assertEquals(false, rowCopy(e("2026-11-01T14:20:00.000Z")).reversed)
    }

    @Test fun anUnknownKindStillReads() {
        val c = rowCopy(e("2026-11-01T14:20:00.000Z", "gift", 0, "Hall"))
        assertEquals("Transaction", c.title); assertEquals("0", c.amount); assertEquals(Sign.Zero, c.sign)
    }

    @Test fun blankPlacesAndNotesAreDropped() = assertNull(rowCopy(e("2026-11-01T14:20:00.000Z", "fixed", 8, "  ")).detail)
}
