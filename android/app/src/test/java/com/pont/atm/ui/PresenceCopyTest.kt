package com.pont.atm.ui

import com.pont.atm.core.PresenceCard
import com.pont.atm.core.PresenceOutcome
import com.pont.atm.core.PresenceResult
import com.pont.atm.core.PresenceToday
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PresenceCopyTest {
    private fun out(points: Int, raw: Int, cappedBy: String?) = PresenceResult(
        "out", PresenceCard("c", "Anna", "/p", 70), "2026-10-22T14:00:00.000Z", "2026-10-22T14:40:00.000Z", 40, points, raw, cappedBy, PresenceToday(points, 100),
    )

    @Test fun durationsReadNaturally() {
        assertEquals("0 min", duration(0)); assertEquals("47 min", duration(47)); assertEquals("1 h", duration(60))
        assertEquals("2 h 5 min", duration(125)); assertEquals("8 h", duration(480))
    }

    @Test fun noLimitNoteWhenNothingWasCut() = assertNull(limitNote(out(24, 24, null)))

    @Test fun theVisitLimitSaysWhatWouldHaveBeenEarned() =
        assertEquals("Visit limit reached: 32 points would have been earned.", limitNote(out(20, 32, "visit")))

    @Test fun theDailyLimitSaysSoWhetherOrNotSomethingWasPaid() {
        assertEquals("Daily limit reached: 32 points would have been earned.", limitNote(out(6, 32, "24h")))
        assertEquals("Daily limit reached. No more points for now.", limitNote(out(0, 32, "24h")))
    }

    @Test fun everyRefusalHasWordsAndASuccessHasNone() {
        assertNull(presenceRefusalCopy(PresenceOutcome.Done(out(1, 1, null))))
        for (o in listOf(PresenceOutcome.Blocked("D", "/p"), PresenceOutcome.UnknownCard, PresenceOutcome.NoConnection, PresenceOutcome.WrongMode, PresenceOutcome.Failed("boom"))) {
            val c = presenceRefusalCopy(o)!!
            assertTrue(c.title.isNotBlank() && c.message.isNotBlank())
        }
    }

    @Test fun noConnectionWarnsThatTheCardMayAlreadyHaveBeenHandled() {
        assertTrue(presenceRefusalCopy(PresenceOutcome.NoConnection)!!.message.contains("may already have been signed in or out"))
        assertFalse(presenceRefusalCopy(PresenceOutcome.NoConnection)!!.message.contains("Nothing"))
    }

    @Test fun anUnregisteredCardTellsThePersonAnAdminKnows() =
        assertTrue(presenceRefusalCopy(PresenceOutcome.UnknownCard)!!.message.contains("An admin has been told"))
}
