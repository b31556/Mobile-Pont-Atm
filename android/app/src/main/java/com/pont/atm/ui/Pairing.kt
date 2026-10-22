package com.pont.atm.ui

/** The server stopped accepting this phone (revoked in admin), so it must go back to the pairing screen. */
fun pairingLost(hasToken: Boolean, onPairScreen: Boolean): Boolean = !hasToken && !onPairScreen

/** Cards are only handled once the phone is paired; before that a tap must not reach either flow. */
fun acceptsCards(hasToken: Boolean): Boolean = hasToken
