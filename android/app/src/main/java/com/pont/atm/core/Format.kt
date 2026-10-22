package com.pont.atm.core

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val hm = DateTimeFormatter.ofPattern("HH:mm")

/** "14:32" in the phone's time zone for a server timestamp; "–" if it can't be read. */
fun formatTime(iso: String, zone: ZoneId = ZoneId.systemDefault()): String =
    runCatching { hm.format(Instant.parse(iso).atZone(zone)) }.getOrDefault("–")
