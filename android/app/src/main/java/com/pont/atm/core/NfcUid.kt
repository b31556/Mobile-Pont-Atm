package com.pont.atm.core

/**
 * Formats the bytes Android's `Tag.getId()` returns as the server's canonical UID: uppercase hex
 * bytes joined by colons. Only 4, 7 and 10 byte UIDs exist for ISO 14443-3A cards; anything else is null.
 * The bytes are used in the order Android hands them over; no reversal is attempted.
 */
fun formatUid(bytes: ByteArray): String? {
    if (bytes.size !in listOf(4, 7, 10)) return null
    return bytes.joinToString(":") { "%02X".format(it.toInt() and 0xFF) }
}
