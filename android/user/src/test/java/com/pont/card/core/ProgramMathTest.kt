package com.pont.card.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

class ProgramMathTest {
    private fun rate(from: String = "08:00", to: String = "12:00", rate: Int = 8, block: Int = 12, cap: Int? = null, maxMin: Int? = null) =
        ProgramEvent("r", "thu", "Rate", "1", from, to, "rate", rate = rate, block = block, cap = cap, maxMin = maxMin)
    private fun tasks(vararg items: Triple<String, Int, Int>, from: String = "08:00", to: String = "12:00") =
        ProgramEvent("t", "thu", "Tasks", "1", from, to, "tasks", items = items.map { TaskItem(it.first, it.second, it.third) })
    private fun flat(from: String = "17:00", to: String = "19:00", cap: Int = 12) = ProgramEvent("f", "wed", "Flat", "1", from, to, "flat", cap = cap)
    private val M = ProgramMath

    @Test fun timesAreMinutesAndBack() {
        assertEquals(510, clock("08:30")); assertEquals(0, clock("junk")); assertEquals("08:05", hm(485)); assertEquals("17:00", hm(1020))
        assertEquals("1 h 10 min", duration(70)); assertEquals("1 h", duration(60)); assertEquals("45 min", duration(45))
    }

    @Test fun anEventRunningAllMorningIsOpen() {
        assertTrue(rate().open); assertFalse(rate(from = "09:00", to = "10:00").open); assertTrue(rate(from = "08:00", to = "12:00").window == 240)
    }

    @Test fun rateEventsPayPerFullBlock() {
        val e = rate()
        assertEquals(0, M.earn(e, 11)); assertEquals(8, M.earn(e, 12)); assertEquals(8, M.earn(e, 23)); assertEquals(40, M.earn(e, 60))
    }

    @Test fun rateEventsRespectTheCapAndTheLongestStay() {
        assertEquals(24, M.earn(rate(cap = 24), 120))
        assertEquals(40, M.earn(rate(maxMin = 60), 200))
        assertEquals(8, M.earn(rate(rate = 2, block = 3, cap = 8), 60))
    }

    @Test fun taskEventsFinishTheBestTasksFirstAndCountTheShareThatFits() {
        val e = tasks(Triple("slow", 4, 20), Triple("fast", 10, 10), Triple("mid", 6, 10))
        assertEquals(5, M.earn(e, 5))           // half of the best task
        assertEquals(10, M.earn(e, 10))         // the best task
        assertEquals(16, M.earn(e, 20))         // + the next best
        assertEquals(20, M.earn(e, 40))         // everything
        assertEquals(20, M.earn(e, 200))
        assertEquals(0, M.earn(e, 0))
    }

    @Test fun aFixedAwardNeedsTheWholeEvent() {
        val e = flat()
        assertEquals(0, M.earn(e, 119)); assertEquals(12, M.earn(e, 120)); assertEquals(12, M.maxPts(e))
    }

    @Test fun firstHourAndEverythingAreComparable() {
        assertEquals(40, M.perHour(rate())); assertEquals(160, M.maxPts(rate()))
        assertEquals(40, M.perHour(rate(from = "09:00", to = "10:00")))
        assertEquals(24, M.perHour(rate(cap = 24)))
        assertEquals(16, M.perHour(tasks(Triple("a", 4, 10), Triple("b", 8, 12), Triple("c", 4, 10))))
    }

    @Test fun aCardIsDroppedWithTheStayThatEarnsWhatAnHourCan() {
        assertEquals(60, M.defaultDur(rate()))
        assertEquals(36, M.defaultDur(rate(cap = 24)))               // 3 blocks of 12 reach the cap
        assertEquals(30, M.defaultDur(rate(maxMin = 30)))
        assertEquals(60, M.defaultDur(rate(from = "09:00", to = "10:00")))
        assertEquals(32, M.defaultDur(tasks(Triple("a", 4, 10), Triple("b", 8, 12), Triple("c", 4, 10))))
        assertEquals(60, M.defaultDur(tasks(Triple("a", 40, 100))))
        assertEquals(120, M.defaultDur(flat()))
    }

    @Test fun theHintSaysHowLongUntilTheNextPoints() {
        val e = rate()
        assertEquals(12, M.nextStep(e, 0)); assertEquals(5, M.nextStep(e, 31)); assertEquals(12, M.nextStep(e, 36))
        assertNull(M.nextStep(rate(cap = 24), 36)); assertNull(M.nextStep(rate(maxMin = 60), 60))
        assertNull(M.nextStep(flat(), 10))
        val t = tasks(Triple("a", 8, 12))
        assertTrue(M.nextStep(t, 0)!! >= 1); assertNull(M.nextStep(t, 12))
    }

    @Test fun freePartsLeaveOutTheOtherStays() {
        assertEquals(listOf(480 to 720), M.freeParts(480, 720, emptyList()))
        assertEquals(listOf(480 to 540, 600 to 720), M.freeParts(480, 720, listOf(Placement(540, 60))))
        assertEquals(listOf(540 to 720), M.freeParts(480, 720, listOf(Placement(400, 140))))
        assertEquals(emptyList<Pair<Int, Int>>(), M.freeParts(480, 720, listOf(Placement(400, 400))))
    }

    @Test fun theGridIsFinerOnAShortDay() { assertEquals(5, M.snapFor(240)); assertEquals(15, M.snapFor(480)) }

    @Test fun aStayLandsWhereItIsDroppedOnTheGrid() {
        val e = rate()
        assertEquals(Placement(600, 60), M.fitAt(e, 600, 60, emptyList(), 5))
        assertEquals(Placement(605, 60), M.fitAt(e, 603, 60, emptyList(), 5))   // 603 rounds to the nearest 5
        assertEquals(Placement(600, 60), M.fitAt(e, 602, 60, emptyList(), 5))
    }

    @Test fun aStayIsKeptInsideTheEventsHours() {
        val e = rate(from = "09:00", to = "10:00")
        assertEquals(Placement(540, 60), M.fitAt(e, 400, 60, emptyList(), 5))
        assertEquals(Placement(540, 60), M.fitAt(e, 900, 60, emptyList(), 5))
        assertEquals(Placement(540, 60), M.fitAt(e, 560, 90, emptyList(), 5).let { it?.copy(dur = 60) })   // longer than the event: cut to it
    }

    @Test fun aStayMovesToTheNearestFreeGap() {
        val e = rate()
        val others = listOf(Placement(540, 60))                      // 09:00-10:00 taken
        assertEquals(Placement(600, 60), M.fitAt(e, 570, 60, others, 5))   // nearer the end of the block than its start
        assertEquals(Placement(480, 60), M.fitAt(e, 530, 60, others, 5))
    }

    @Test fun aStayShrinksToASmallerGapButAFixedAwardDoesNot() {
        val e = rate(from = "09:00", to = "10:00")
        val others = listOf(Placement(540, 40))                      // only 20 minutes left
        assertEquals(Placement(580, 20), M.fitAt(e, 560, 60, others, 5))
        val f = flat()
        assertNull(M.fitAt(f, 1020, 120, listOf(Placement(1100, 10)), 5))
    }

    @Test fun nothingFitsWhenTheEventIsFull() {
        assertNull(M.fitAt(rate(from = "09:00", to = "10:00"), 540, 30, listOf(Placement(540, 60)), 5))
    }

    @Test fun theDayLineShowsWholeHoursAroundTheEvents() {
        assertEquals(480 to 720, M.domain(listOf(rate(), rate(from = "09:00", to = "11:30"))))
        assertEquals(480 to 780, M.domain(listOf(rate(from = "08:15", to = "12:10"))))
        assertEquals(480 to 720, M.domain(emptyList()))
    }

    @Test fun earnedPointsOfADayLeaveOutCancelledGrants() {
        val z = ZoneId.of("UTC")
        val h = listOf(
            HistoryEntry("2026-10-22T08:10:00Z", "fixed", 10),
            HistoryEntry("2026-10-22T09:00:00Z", "presence", 24),
            HistoryEntry("2026-10-22T09:30:00Z", "fixed", 8, stornoed = true),
            HistoryEntry("2026-10-22T09:31:00Z", "storno", -8),
            HistoryEntry("2026-10-21T16:00:00Z", "fixed", 12),
        )
        assertEquals(34, earnedOn(h, "2026-10-22", z)); assertEquals(12, earnedOn(h, "2026-10-21", z)); assertEquals(0, earnedOn(h, "2026-10-23", z))
        assertEquals(0, earnedOn(h, "junk", z))
        assertEquals(0, earnedOn(listOf(HistoryEntry("2026-10-22T08:00:00Z", "adjust", -5)), "2026-10-22", z))
    }

    @Test fun theServersDocumentIsReadWhateverItAddsLater() {
        val doc = PontJson.decodeFromString(ProgramDoc.serializer(), """{"title":"T","extra":1,"days":[{"key":"thu","label":"Thu","date":"2026-10-22"}],
          "goal":{"total":90,"dayKey":"thu","dayMin":50},"updatedAt":"x",
          "events":[{"id":"a","day":"thu","title":"Chess","room":"Library","from":"09:00","to":"10:00","model":"rate","rate":8,"block":12,"future":true},
                    {"id":"b","day":"thu","title":"Island","room":"14","from":"08:00","to":"12:00","model":"tasks","items":[{"name":"Quiz","pts":4,"min":10}],"kind":"mix"}]}""")
        assertEquals(2, doc.events.size); assertEquals("time", doc.events[0].kindKey); assertEquals("mix", doc.events[1].kindKey)
        assertEquals(50, doc.goal.dayMin); assertEquals("09:00–10:00", doc.events[0].range())
    }

    @Test fun earnedSoFarCountsOnlyTheDaysOfTheProgramNotTheWholeBalance() {
        val z = ZoneId.of("UTC")
        val days = listOf(ProgramDay("d1", "Day 1", "2026-10-21"), ProgramDay("d2", "Day 2", "2026-10-22"))
        val h = listOf(
            HistoryEntry("2026-10-21T10:00:00Z", "fixed", 12), HistoryEntry("2026-10-22T09:00:00Z", "presence", 30),
            HistoryEntry("2026-10-22T09:30:00Z", "fixed", 8, stornoed = true), HistoryEntry("2026-10-22T09:31:00Z", "storno", -8),
            HistoryEntry("2026-09-01T09:00:00Z", "fixed", 100),     // points from some other event
        )
        assertEquals(42, earnedOnDays(h, days, z))
        assertEquals(0, earnedOnDays(emptyList(), days, z))
        assertEquals(0, earnedOnDays(h, emptyList(), z))
    }

    @Test fun onlyStaysStillAheadCountAsPlanned() {
        val past = ProgramDay("a", "A", "2026-10-21"); val today = ProgramDay("b", "B", "2026-10-22"); val future = ProgramDay("c", "C", "2026-10-23")
        val stay = Placement(600, 60)                                       // 10:00-11:00
        assertFalse(stillAhead(past, stay, "2026-10-22", 0))               // a day that is over
        assertTrue(stillAhead(future, stay, "2026-10-22", 1000))           // a later day, whatever the time
        assertTrue(stillAhead(today, stay, "2026-10-22", 540))             // not started
        assertTrue(stillAhead(today, stay, "2026-10-22", 630))             // in progress
        assertFalse(stillAhead(today, stay, "2026-10-22", 660))            // just ended
        assertFalse(stillAhead(today, stay, "2026-10-22", 900))            // over
        assertFalse(stillAhead(null, stay, "2026-10-22", 0))               // not a day of the program
    }

    @Test fun dayNamesStayDifferentOnTheDaySwitch() {
        val named = listOf(ProgramDay("a", "Wed 21 Oct", "2026-10-21"), ProgramDay("b", "Thu 22 Oct", "2026-10-22"))
        assertEquals(listOf("Wed", "Thu"), shortDayLabels(named))
        val numbered = listOf(ProgramDay("a", "Day 1", "2026-01-10"), ProgramDay("b", "Day 2", "2026-01-11"))
        assertEquals(listOf("Day 1", "Day 2"), shortDayLabels(numbered))
        assertEquals(listOf("Friday"), shortDayLabels(listOf(ProgramDay("a", "Friday", "2026-01-10"))))
    }
}
