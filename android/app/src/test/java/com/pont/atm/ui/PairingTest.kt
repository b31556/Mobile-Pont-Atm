package com.pont.atm.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingTest {
    @Test fun aPhoneThatLostItsTokenGoesBackToPairing() = assertTrue(pairingLost(hasToken = false, onPairScreen = false))
    @Test fun aPhoneAlreadyOnThePairScreenStaysThere() = assertFalse(pairingLost(hasToken = false, onPairScreen = true))
    @Test fun aPairedPhoneIsLeftAlone() {
        assertFalse(pairingLost(hasToken = true, onPairScreen = false))
        assertFalse(pairingLost(hasToken = true, onPairScreen = true))
    }
    @Test fun cardsAreIgnoredUntilThePhoneIsPaired() {
        assertFalse(acceptsCards(hasToken = false)); assertTrue(acceptsCards(hasToken = true))
    }
}
