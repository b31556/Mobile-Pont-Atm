package com.pont.atm.ui

import com.pont.atm.core.CardInfo
import com.pont.atm.core.ChargeOutcome
import com.pont.atm.core.TxInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutcomeCopyTest {
    @Test fun noConnectionDoesNotPromiseThatNothingWasCharged() {
        val c = refusalCopy(ChargeOutcome.NoConnection, "04:A2:3B:1C")!!
        assertEquals("No connection", c.title)
        assertFalse("must not say nothing was charged", c.message.contains("Nothing was charged", ignoreCase = true))
        assertTrue(c.message.contains("may already have been credited"))
        assertTrue("points the operator at History", c.message.contains("History"))
    }

    @Test fun aServerFailureAlsoWarnsToCheckHistory() {
        val c = refusalCopy(ChargeOutcome.Failed("Server error"), "04:A2:3B:1C")!!
        assertTrue(c.message.startsWith("Server error"))
        assertTrue(c.message.contains("History"))
    }

    @Test fun blockedAndUnknownCardsAreDefinitelyNotCharged() {
        assertTrue(refusalCopy(ChargeOutcome.Blocked("Dóra", "/p"), "04:55:0A:B3")!!.message.contains("No points were given"))
        val unknown = refusalCopy(ChargeOutcome.UnknownCard, "04:EE:00:77")!!
        assertTrue(unknown.message.contains("04:EE:00:77") && unknown.message.contains("No points were given"))
    }

    @Test fun successHasNoRefusalCopy() {
        val ok = ChargeOutcome.Success(TxInfo(1, 8, "x", "Bar 2"), CardInfo("c", "Anna", "/p", 1, 9))
        assertNull(refusalCopy(ok, "04:A2:3B:1C"))
    }
}
