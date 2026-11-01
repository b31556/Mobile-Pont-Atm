package com.pont.atm.ui

import com.pont.atm.core.InfoOutcome
import com.pont.atm.core.InfoResult
import com.pont.atm.core.InfoCard
import com.pont.atm.core.InfoRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class InfoCopyTest {
    private fun row(kind: String, amount: Int = 8, place: String = "Bar 2", note: String? = null, stornoed: Boolean = false) =
        InfoRow("2026-10-22T14:32:00.000Z", kind, amount, place, note, stornoed)

    @Test fun pointsGivenByATerminalAreReceived() {
        assertEquals(InfoRowCopy("Points received", "Bar 2", false), infoRowCopy(row("fixed")))
        assertEquals(InfoRowCopy("Points received", "Bar 2", false), infoRowCopy(row("atm")))
    }

    @Test fun aCheckOutShowsThePlaceAndTheDuration() =
        assertEquals(InfoRowCopy("Check-out", "Gym · 34 min", false), infoRowCopy(row("presence", 24, "Gym", "34 min")))

    @Test fun anAdjustmentShowsTheReason() =
        assertEquals(InfoRowCopy("Adjustment", "Prize", false), infoRowCopy(row("adjust", -3, "", "Prize")))

    @Test fun aStornoIsARefundAndAReversedRowIsFlagged() {
        assertEquals("Refund", infoRowCopy(row("storno", -8)).title)
        assertTrue(infoRowCopy(row("fixed", stornoed = true)).reversed)
    }

    @Test fun anUnknownKindStillGetsAName() = assertEquals("Transaction", infoRowCopy(row("gift")).title)

    @Test fun amountsCarryTheirSign() {
        assertEquals("+8", signedAmount(8)); assertEquals("−3", signedAmount(-3)); assertEquals("0", signedAmount(0))
    }

    @Test fun todaysRowsShowOnlyTheTime() {
        val utc = ZoneId.of("UTC")
        assertEquals("14:32", infoRowTime("2026-10-22T14:32:00.000Z", LocalDate.of(2026, 10, 22), utc))
        assertEquals("22 Oct 14:32", infoRowTime("2026-10-22T14:32:00.000Z", LocalDate.of(2026, 10, 23), utc))
        assertEquals("–", infoRowTime("nonsense", LocalDate.of(2026, 10, 23), utc))
    }

    @Test fun everyRefusalHasWordsAndASuccessHasNone() {
        val ok = InfoOutcome.Done(InfoResult("info", InfoCard("c", "A", "/p", 1)))
        assertNull(infoRefusalCopy(ok)); assertTrue(infoSucceeded(ok))
        for (o in listOf(InfoOutcome.Blocked("D", "/p"), InfoOutcome.UnknownCard, InfoOutcome.NoConnection, InfoOutcome.WrongMode, InfoOutcome.Failed("boom"))) {
            val c = infoRefusalCopy(o)!!
            assertTrue(c.title.isNotBlank() && c.message.isNotBlank())
            assertFalse(infoSucceeded(o))
        }
    }
}
