package com.pont.card.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelsTest {
    private val body = """{"cards":[
      {"uid":"04:A2:3B:1C","found":true,"name":"Anna Kovács","status":"active","balance":12,"photo":"data:image/jpeg;base64,/9j/4AAQ","future":"x",
       "history":[{"at":"2026-11-01T14:20:00.000Z","kind":"fixed","amount":8,"place":"Bar 2","note":null,"stornoed":false,"id":9},
                  {"at":"2026-11-01T10:00:00.000Z","kind":"presence","amount":4,"place":"Gym","note":"34 min","stornoed":true}]},
      {"uid":"04:BB:CC:DD","found":false},
      {"uid":"04:00:00:01","found":true,"name":"Dóra","status":"blocked","balance":0,"photo":null,"history":[]}
    ],"extra":1}"""

    private val cards = PontJson.decodeFromString(CardsResponse.serializer(), body).cards

    @Test fun aFoundCardIsParsedInFull() {
        val a = cards[0]
        assertTrue(a.found); assertEquals("Anna Kovács", a.name); assertEquals(12, a.balance); assertFalse(a.blocked)
        assertEquals("data:image/jpeg;base64,/9j/4AAQ", a.photo)
        assertEquals(2, a.history.size)
        assertEquals(HistoryEntry("2026-11-01T14:20:00.000Z", "fixed", 8, "Bar 2", null, false), a.history[0])
        assertEquals("34 min", a.history[1].note); assertTrue(a.history[1].stornoed)
    }

    @Test fun anUnregisteredCardOnlyHasItsUid() {
        val b = cards[1]
        assertEquals("04:BB:CC:DD", b.uid); assertFalse(b.found); assertEquals("", b.name); assertTrue(b.history.isEmpty()); assertNull(b.photo)
    }

    @Test fun aBlockedCardWithNoPhotoIsParsed() {
        val c = cards[2]
        assertTrue(c.blocked); assertNull(c.photo); assertEquals(0, c.balance)
    }

    @Test fun nullsWhereTheAppHasADefaultAreTolerated() {
        val c = PontJson.decodeFromString(PublicCard.serializer(),
            """{"uid":"u","found":true,"name":"A","status":null,"balance":1,"history":[{"at":"2026-11-01T14:20:00.000Z","kind":"adjust","amount":-2,"place":null,"note":"Fix","stornoed":null}]}""")
        assertEquals("active", c.status); assertEquals("", c.history[0].place); assertEquals(-2, c.history[0].amount); assertFalse(c.history[0].stornoed)
    }

    @Test fun theRequestIsTheDocumentedShape() =
        assertEquals("""{"uids":["04:A2:3B:1C","04BBCCDD"]}""", PontJson.encodeToString(CardsRequest.serializer(), CardsRequest(listOf("04:A2:3B:1C", "04BBCCDD"))))

    @Test fun photoBytesComeOutOfADataUrl() {
        assertEquals("hello", String(decodePhotoBytes("data:image/jpeg;base64,aGVsbG8=")!!))
        assertEquals("hello", String(decodePhotoBytes("aGVsbG8=")!!))
        assertEquals("hello", String(decodePhotoBytes("data:image/png;base64,aGVs\nbG8=")!!))
        assertNull(decodePhotoBytes(null)); assertNull(decodePhotoBytes("")); assertNull(decodePhotoBytes("data:image/jpeg;base64,")); assertNull(decodePhotoBytes("data:image/jpeg;base64,@@@@"))
    }
}
