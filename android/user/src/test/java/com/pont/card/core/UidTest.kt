package com.pont.card.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UidTest {
    private fun b(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

    @Test fun fourByteUidIsUppercaseColonSeparated() = assertEquals("04:A2:3B:1C", formatUid(b(0x04, 0xA2, 0x3B, 0x1C)))
    @Test fun sevenByteUid() = assertEquals("04:A2:3B:1C:5D:6E:7F", formatUid(b(0x04, 0xA2, 0x3B, 0x1C, 0x5D, 0x6E, 0x7F)))
    @Test fun tenByteUid() = assertEquals(29, formatUid(ByteArray(10) { (it + 1).toByte() })!!.length)
    @Test fun smallBytesKeepTheirLeadingZero() = assertEquals("00:0A:01:FF", formatUid(b(0x00, 0x0A, 0x01, 0xFF)))

    @Test fun unsupportedLengthsAreNull() {
        assertNull(formatUid(b(1, 2, 3, 4, 5)))
        assertNull(formatUid(b(1, 2, 3)))
        assertNull(formatUid(ByteArray(0)))
        assertNull(formatUid(ByteArray(8))) // NFC-F and NFC-V tags have 8 byte ids
    }

    @Test fun anySpellingBecomesTheCanonicalOne() {
        for (s in listOf("04:A2:3B:1C", "04a23b1c", "04-A2-3B-1C", "04 a2 3b 1c", " 04A23B1C ".trim(), "04:a2:3B:1c"))
            assertEquals(s, "04:A2:3B:1C", normalizeUid(s))
        assertEquals("04:A2:3B:1C:5D:6E:7F", normalizeUid("04A23B1C5D6E7F"))
    }

    @Test fun nonsenseIsNotAUid() {
        assertNull(normalizeUid("")); assertNull(normalizeUid("04A23B")); assertNull(normalizeUid("04A23B1")); assertNull(normalizeUid("ZZZZZZZZ"))
        assertNull(normalizeUid("04A23B1C5D")) // 5 bytes
    }
}
