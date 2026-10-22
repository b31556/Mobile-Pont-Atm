package com.pont.atm.ui

import com.pont.atm.core.PresenceCard
import com.pont.atm.core.ZoneRef
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

    // ---- what the screen says for each kind of tap ----

    private fun result(action: String, inAt: String? = "2026-10-22T14:00:00.000Z", outAt: String? = null, minutes: Int? = null, points: Int = 0, expired: Int? = null, zone: String? = "Gym") =
        PresenceResult(action, PresenceCard("c", "Anna", "/p", 70), inAt, outAt, minutes, points, points, null, PresenceToday(points, null), expired, zone?.let { ZoneRef("z", it) })
    private fun copy(r: PresenceResult) = visitCopy(r, java.time.ZoneOffset.UTC)

    @Test fun checkInShowsSinceAndZone() {
        val c = copy(result("in"))
        assertEquals("Checked in", c.title); assertEquals(Tone.Good, c.tone)
        assertTrue(c.notes.contains("Since 14:00")); assertTrue(c.notes.contains("Zone: Gym"))
        assertTrue(c.notes.any { it.startsWith("Balance: 70") })
    }

    @Test fun checkOutShowsTimeInsideAndTheDay() {
        val c = copy(result("out", outAt = "2026-10-22T14:40:00.000Z", minutes = 40, points = 24))
        assertEquals("Checked out", c.title); assertEquals(Tone.Good, c.tone)
        assertTrue(c.notes.contains("Inside 40 min  ·  14:00 to 14:40")); assertTrue(c.notes.contains("Today: 24 points"))
    }

    @Test fun alreadyCheckedInSaysWhereAndWhatToDo() {
        val c = copy(result("already_in"))
        assertEquals("Already checked in", c.title); assertEquals(Tone.Neutral, c.tone)
        assertTrue(c.notes.any { it.contains("Since 14:00") && it.contains("Gym") }); assertTrue(c.notes.any { it.contains("sign-out point") })
    }

    @Test fun notCheckedInIsAWarningThatTellsThemToSignInFirst() {
        val c = copy(result("not_in", inAt = null))
        assertEquals("Not checked in", c.title); assertEquals(Tone.Warn, c.tone)
        assertTrue(c.notes.any { it.contains("sign-in point") })
    }

    @Test fun aForgottenSignOutAtAnExitEarnsNothingAndSaysSo() {
        val c = copy(result("expired_out", expired = 780))
        assertEquals("Checked out", c.title); assertEquals(Tone.Warn, c.tone)
        assertTrue(c.notes.any { it.contains("earned no points") })
    }

    @Test fun aForgottenSignOutAtAnEntranceChecksInAndSaysSo() {
        val c = copy(result("expired_in", expired = 780))
        assertEquals("Checked in", c.title); assertEquals(Tone.Warn, c.tone)
        assertTrue(c.notes.any { it.contains("earned no points") })
    }

    @Test fun aReTapInsideTheLockOutIsNeutral() {
        val c = copy(result("cooldown"))
        assertEquals("Already checked in", c.title); assertEquals(Tone.Neutral, c.tone)
    }

    @Test fun theZoneLineIsLeftOutWhenTheServerSendsNone() {
        assertFalse(copy(result("in", zone = null)).notes.any { it.startsWith("Zone:") })
    }

    @Test fun theDailyLimitIsStillExplained() {
        val c = copy(PresenceResult("out", PresenceCard("c", "A", "/p", 1), "2026-10-22T14:00:00.000Z", "2026-10-22T14:40:00.000Z", 40, 6, 32, "24h", PresenceToday(30, 30), null, null))
        assertTrue(c.notes.contains("Daily limit reached: 32 points would have been earned."))
        assertTrue(c.notes.contains("Today: 30 of 30 points"))
    }

    // ---- sounds ----

    @Test fun soundsFollowWhatHappened() {
        fun sound(a: String) = presenceSound(PresenceOutcome.Done(result(a)))
        assertEquals(PresenceSound.CheckIn, sound("in"))
        assertEquals(PresenceSound.Success, sound("out"))
        assertEquals(PresenceSound.CheckIn, sound("cooldown"))
        assertEquals(PresenceSound.CheckIn, sound("expired_in"))
        assertEquals(PresenceSound.CheckIn, sound("expired_out"))
        assertEquals(PresenceSound.Refusal, sound("already_in"))
        assertEquals(PresenceSound.Refusal, sound("not_in"))
        for (o in listOf(PresenceOutcome.Blocked("D", "/p"), PresenceOutcome.UnknownCard, PresenceOutcome.NoConnection, PresenceOutcome.WrongMode, PresenceOutcome.Failed("x")))
            assertEquals(PresenceSound.Refusal, presenceSound(o))
    }

    // ---- the waiting screen ----

    @Test fun theWaitingScreenSaysWhatThisPointDoes() {
        assertEquals("Tap to sign in", idleTitle("in")); assertEquals("Tap to sign out", idleTitle("out"))
        assertEquals("Tap your card", idleTitle("toggle")); assertEquals("Tap your card", idleTitle("anything else"))
    }
}
