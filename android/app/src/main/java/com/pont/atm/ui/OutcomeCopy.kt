package com.pont.atm.ui

import com.pont.atm.core.ChargeOutcome

data class OutcomeCopy(val title: String, val message: String)

/**
 * Words for a charge that did not come back as a success, or null for a success.
 * Only a blocked or unregistered card is a definite "nothing was charged". A lost connection or a server
 * error can happen after the server credited the card, so those say so and point to History.
 */
fun refusalCopy(outcome: ChargeOutcome, uid: String): OutcomeCopy? = when (outcome) {
    is ChargeOutcome.Success -> null
    is ChargeOutcome.Blocked -> OutcomeCopy("Card is blocked", "Ask an admin to unblock it. No points were given.")
    ChargeOutcome.UnknownCard -> OutcomeCopy("Card not registered", "Tag $uid isn't in the system. Ask an admin to add it. No points were given.")
    ChargeOutcome.NoConnection -> OutcomeCopy(
        "No connection",
        "Couldn't confirm the charge. The card may already have been credited. Tap again to check, or look in History before charging again.",
    )
    is ChargeOutcome.Failed -> OutcomeCopy("Couldn't give points", "${outcome.message} The card may already have been credited. Check History before charging again.")
}
