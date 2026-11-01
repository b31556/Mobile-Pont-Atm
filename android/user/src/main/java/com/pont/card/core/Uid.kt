package com.pont.card.core

/**
 * Formats the bytes Android's `Tag.getId()` returns as the server's canonical UID: uppercase hex
 * bytes joined by colons ("04:A2:3B:1C"). Only 4, 7 and 10 byte UIDs exist for ISO 14443-3A cards;
 * anything else is null. The bytes are used in the order Android hands them over.
 */
fun formatUid(bytes: ByteArray): String? {
    if (bytes.size !in listOf(4, 7, 10)) return null
    return bytes.joinToString(":") { "%02X".format(it.toInt() and 0xFF) }
}

/**
 * Any common spelling of a UID ("04a23b1c", "04-A2-3B-1C", "04 a2 3b 1c", "04:A2:3B:1C") in the canonical form,
 * or null if it is not 4, 7 or 10 hex bytes.
 */
fun normalizeUid(raw: String): String? {
    val hex = raw.filter { it != ':' && it != '-' && it != ' ' }.uppercase()
    if (hex.length % 2 != 0 || hex.isEmpty() || !hex.all { it in '0'..'9' || it in 'A'..'F' }) return null
    val bytes = hex.chunked(2)
    if (bytes.size !in listOf(4, 7, 10)) return null
    return bytes.joinToString(":")
}
