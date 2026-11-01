package com.pont.atm.ui

import com.pont.atm.core.CancelKey
import com.pont.atm.core.CancelResult
import com.pont.atm.core.PresenceCard
import com.pont.atm.core.PresenceDiscarded
import com.pont.atm.core.PresenceOutcome
import com.pont.atm.core.PresenceResult
import com.pont.atm.core.PresenceToday
import com.pont.atm.core.ZoneRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PresenceCancelCopyTest {
    private fun result(action: String, points: Int = 0, balance: Int = 70, sessionId: Long? = 77, discarded: PresenceDiscarded? = null) = PresenceResult(
        action, PresenceCard("c", "Anna Kovács", "/p", balance), "2026-10-22T14:00:00.000Z", "2026-10-22T14:40:00.000Z", 40, points, points, null,
        PresenceToday(points, null), null, null, sessionId, discarded,
    )

    @Test fun theDiscardWarningNamesTheZoneAndTheLostVisit() =
        assertEquals("Still checked in at Main area: that visit (40 min) was cancelled, no points for it.", discardWarning(PresenceDiscarded("Main area", 40)))

    @Test fun theDiscardWarningReadsLongVisitsAndMissingZones() {
        assertEquals("Still checked in at Gym: that visit (2 h 5 min) was cancelled, no points for it.", discardWarning(PresenceDiscarded("Gym", 125)))
        assertEquals("Still checked in at another zone: that visit (0 min) was cancelled, no points for it.", discardWarning(PresenceDiscarded("", 0)))
    }

    @Test fun aSignInThatCancelledAVisitGetsTheWarningBeepButOthersKeepTheirSound() {
        assertEquals(PresenceSound.Refusal, presenceSound(PresenceOutcome.Done(result("in", discarded = PresenceDiscarded("Main area", 40)))))
        assertEquals(PresenceSound.CheckIn, presenceSound(PresenceOutcome.Done(result("in"))))
        assertEquals(PresenceSound.Success, presenceSound(PresenceOutcome.Done(result("out", 24))))
    }

    @Test fun aWarningResultStaysLongerOnScreen() {
        assertEquals(8_000L, presenceShowMs(PresenceOutcome.Done(result("in", discarded = PresenceDiscarded("Main area", 40)))))
        assertEquals(5_000L, presenceShowMs(PresenceOutcome.Done(result("in"))))
        assertEquals(5_000L, presenceShowMs(PresenceOutcome.NoConnection))
    }

    @Test fun onlyCheckInsAndCheckOutsCanBeCancelled() {
        assertEquals(CancelKey(77, "in"), cancelKeyOf(result("in")))
        assertEquals(CancelKey(77, "out"), cancelKeyOf(result("out", 24)))
        for (a in listOf("cooldown", "already_in", "not_in", "expired_in", "expired_out")) assertNull(a, cancelKeyOf(result(a)))
        assertNull(cancelKeyOf(result("in", sessionId = null)))
    }

    @Test fun theButtonsSayWhichEndTheyCancel() {
        assertEquals("Cancel this check-in", cancelButtonLabel(CancelKey(1, "in")))
        assertEquals("Cancel this check-out", cancelButtonLabel(CancelKey(1, "out")))
    }

    @Test fun cancellingACheckInSaysNoPointsArePaid() =
        assertEquals(OutcomeCopy("Cancel this check-in?", "Anna Kovács is no longer inside. No points are paid."), cancelQuestion(result("in"), CancelKey(77, "in")))

    @Test fun cancellingACheckOutSaysWhatTheBalanceBecomes() =
        assertEquals(
            OutcomeCopy("Cancel this check-out?", "Anna Kovács will lose 24 points (balance 70 → 46) and is inside again as if they had not signed out."),
            cancelQuestion(result("out", points = 24, balance = 70), CancelKey(77, "out")),
        )

    @Test fun cancellingAFreeCheckOutTakesNothingBack() {
        assertEquals("Anna Kovács will lose 1 point (balance 5 → 4) and is inside again as if they had not signed out.", cancelQuestion(result("out", 1, 5), CancelKey(1, "out")).message)
        assertEquals("No points are taken back, and Anna Kovács is inside again as if they had not signed out.", cancelQuestion(result("out", 0, 5), CancelKey(1, "out")).message)
    }

    @Test fun theCancelledScreenSaysWhatHappened() {
        val card = PresenceCard("c", "Anna", "/p", 46)
        val out = CancelResult("cancelled_out", 24, card, ZoneRef("z1", "Gym"))
        assertEquals("Check-out cancelled", cancelledTitle(out))
        assertEquals(listOf("24 points taken back", "Zone: Gym", "Balance: 46 points"), cancelledNotes(out))
        val inn = CancelResult("cancelled_in", 0, card)
        assertEquals("Check-in cancelled", cancelledTitle(inn))
        assertEquals(listOf("Balance: 46 points"), cancelledNotes(inn))
    }
}
