package com.pont.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyTest {
    @Test fun uidInTheServersForm() {
        assertEquals("04:A2:3B:1C", formatUid(byteArrayOf(0x04, 0xA2.toByte(), 0x3B, 0x1C)))
        assertEquals("04:A2:3B:1C:55:66:77", formatUid(byteArrayOf(0x04, 0xA2.toByte(), 0x3B, 0x1C, 0x55, 0x66, 0x77)))
        assertEquals("00:00:00:01", formatUid(byteArrayOf(0, 0, 0, 1)))
    }

    @Test fun uidSizesThatDoNotExistAreRefused() {
        assertNull(formatUid(byteArrayOf()))
        assertNull(formatUid(byteArrayOf(1, 2, 3)))
        assertNull(formatUid(ByteArray(8)))
        assertNull(formatUid(ByteArray(11)))
    }

    @Test fun onlyTheAdminServerOpensInsideTheApp() {
        val base = "https://pont.example.com"
        assertTrue(isSameOrigin("https://pont.example.com/admin/", base))
        assertTrue(isSameOrigin("https://PONT.EXAMPLE.COM:443/display", base))
        assertFalse(isSameOrigin("http://pont.example.com/admin/", base))
        assertFalse(isSameOrigin("https://pont.example.com.evil.example/admin/", base))
        assertFalse(isSameOrigin("https://evil.example/pont.example.com", base))
        assertFalse(isSameOrigin("https://pont.example.com:8443/", base))
        assertFalse(isSameOrigin("javascript:alert(1)", base))
        assertFalse(isSameOrigin("file:///sdcard/x.html", base))
        assertFalse(isSameOrigin("intent://x#Intent;end", base))
        assertFalse(isSameOrigin("not a url", base))
    }

    @Test fun theEmulatorAddressWorksToo() {
        assertTrue(isSameOrigin("http://10.0.2.2:3000/admin/", "http://10.0.2.2:3000"))
        assertFalse(isSameOrigin("http://10.0.2.2:3001/admin/", "http://10.0.2.2:3000"))
    }

    @Test fun onlyWebAddressesGoToTheBrowser() {
        assertTrue(isWebAddress("https://example.com/a"))
        assertTrue(isWebAddress("http://example.com"))
        assertFalse(isWebAddress("intent://scan/#Intent;scheme=zxing;end"))
        assertFalse(isWebAddress("javascript:alert(1)"))
        assertFalse(isWebAddress("market://details?id=x"))
        assertFalse(isWebAddress(""))
    }

    @Test fun savedFileNamesStayInDownloads() {
        assertEquals("pont-report-Anna.xlsx", safeFileName("pont-report-Anna.xlsx"))
        assertEquals("passwd", safeFileName("../../etc/passwd"))
        assertEquals("evil.xlsx", safeFileName("C:\\Windows\\evil.xlsx"))
        assertEquals("a_b_c.xlsx", safeFileName("a<b>c.xlsx"))
        assertEquals("hidden", safeFileName(".hidden"))
        assertEquals("download", safeFileName(""))
        assertEquals("download", safeFileName("/"))
        assertTrue(safeFileName("x".repeat(500) + ".xlsx").length <= 100)
    }

    @Test fun textInAScriptCannotBreakOut() {
        assertEquals("\"04:A2:3B:1C\"", jsString("04:A2:3B:1C"))
        assertEquals("\"a\\\"b\"", jsString("a\"b"))
        assertEquals("\"a\\\\b\"", jsString("a\\b"))
        assertEquals("\"a\\nb\"", jsString("a\nb"))
        assertEquals("\"\\u0000\"", jsString("\u0000"))
        assertEquals("\"\\u2028\"", jsString("\u2028"))
        assertEquals("\"</script>\"", jsString("</script>"))
    }
}
