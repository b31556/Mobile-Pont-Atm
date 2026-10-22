package com.pont.atm.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NfcUidTest {
    private fun b(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

    @Test fun fourByteUidIsUppercaseColonSeparated() =
        assertEquals("04:A2:3B:1C", formatUid(b(0x04, 0xA2, 0x3B, 0x1C)))

    @Test fun sevenByteUid() =
        assertEquals("04:A2:3B:1C:5D:6E:7F", formatUid(b(0x04, 0xA2, 0x3B, 0x1C, 0x5D, 0x6E, 0x7F)))

    @Test fun tenByteUid() =
        assertEquals(29, formatUid(ByteArray(10) { (it + 1).toByte() })!!.length)

    @Test fun smallBytesKeepTheirLeadingZero() =
        assertEquals("00:0A:01:FF", formatUid(b(0x00, 0x0A, 0x01, 0xFF)))

    @Test fun unsupportedLengthsAreNull() {
        assertNull(formatUid(b(1, 2, 3, 4, 5)))
        assertNull(formatUid(b(1, 2, 3)))
        assertNull(formatUid(ByteArray(0)))
    }
}
