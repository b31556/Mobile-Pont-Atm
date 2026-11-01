package com.pont.admin

import java.net.URI

/**
 * Formats the bytes Android's `Tag.getId()` returns as the server's canonical UID: uppercase hex bytes joined by
 * colons ("04:A2:3B:1C"). Only 4, 7 and 10 byte UIDs exist for ISO 14443-3A cards; anything else is null.
 */
fun formatUid(bytes: ByteArray): String? {
    if (bytes.size !in listOf(4, 7, 10)) return null
    return bytes.joinToString(":") { "%02X".format(it.toInt() and 0xFF) }
}

/** Scheme, host and port of an address, lower case, with the default port filled in; null if it is not an http(s) address. */
private fun originOf(url: String): Triple<String, String, Int>? {
    val uri = runCatching { URI(url.trim()) }.getOrNull() ?: return null
    val scheme = uri.scheme?.lowercase() ?: return null
    val host = uri.host?.lowercase() ?: return null
    if (scheme != "http" && scheme != "https") return null
    val port = if (uri.port != -1) uri.port else if (scheme == "https") 443 else 80
    return Triple(scheme, host, port)
}

/** Whether [url] is on the same server as [base]. Only the admin site's own pages may open inside the app. */
fun isSameOrigin(url: String, base: String): Boolean {
    val a = originOf(url) ?: return false
    return a == originOf(base)
}

/** Whether [url] may be handed to the phone's browser: a plain web address. */
fun isWebAddress(url: String): Boolean = originOf(url) != null

/** A file name that is safe to create in Downloads: no folders, no odd characters, not empty, not too long. */
fun safeFileName(name: String): String {
    val base = name.substringAfterLast('/').substringAfterLast('\\')
    val cleaned = base.replace(Regex("[^A-Za-z0-9._ -]"), "_").trim().trimStart('.')
    val limited = if (cleaned.length > 100) cleaned.takeLast(100) else cleaned
    return limited.ifBlank { "download" }
}

/** [text] as a JavaScript string literal, safe to put in a script. */
fun jsString(text: String): String {
    val out = StringBuilder("\"")
    for (c in text) when {
        c == '"' -> out.append("\\\"")
        c == '\\' -> out.append("\\\\")
        c == '\n' -> out.append("\\n")
        c == '\r' -> out.append("\\r")
        c == ' ' -> out.append("\\u2028")
        c == ' ' -> out.append("\\u2029")
        c < ' ' -> out.append("\\u%04x".format(c.code))
        else -> out.append(c)
    }
    return out.append('"').toString()
}
