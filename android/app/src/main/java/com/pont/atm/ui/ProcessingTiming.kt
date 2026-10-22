package com.pont.atm.ui

/** How long the progress screen stays up. It only needs to be long enough to see; the real wait is the server's. */
object ProcessingTiming {
    const val MIN_MS = 450L
    const val STAGE_MS = 150L

    /** Time still to wait before showing the result, given how long the charge has already taken. */
    fun remaining(elapsedMs: Long): Long = (MIN_MS - elapsedMs).coerceAtLeast(0)
}
