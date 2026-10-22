package com.pont.atm.core

import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Test

class FormatTest {
    @Test fun timeIsShownAsHoursAndMinutesInTheGivenZone() =
        assertEquals("14:32", formatTime("2026-10-22T14:32:07.123Z", ZoneOffset.UTC))
    @Test fun aZoneShiftsTheClock() =
        assertEquals("16:32", formatTime("2026-10-22T14:32:07.123Z", ZoneOffset.ofHours(2)))
    @Test fun garbageIsShownAsADash() = assertEquals("–", formatTime("not a time"))
}
