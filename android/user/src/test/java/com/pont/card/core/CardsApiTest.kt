package com.pont.card.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class CardsApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: CardsApi

    @Before fun setUp() {
        server = MockWebServer().also { it.start() }
        api = CardsApi(server.url("/").toString().trimEnd('/'))
    }
    @After fun tearDown() { runCatching { server.shutdown() } }

    private fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("content-type", "application/json").setBody(body)

    private val ok = """{"cards":[
        {"uid":"04:A2:3B:1C","found":true,"name":"Anna Kovács","status":"active","balance":12,"photo":null,
         "history":[{"at":"2026-11-01T14:20:00.000Z","kind":"fixed","amount":8,"place":"Bar 2","note":null,"stornoed":false}]},
        {"uid":"04:BB:CC:DD","found":false}]}"""

    @Test fun successReturnsTheCards() = runBlocking {
        server.enqueue(json(200, ok))
        val r = api.fetch(listOf("04:A2:3B:1C", "04BBCCDD")) as FetchResult.Ok
        assertEquals(2, r.cards.size)
        assertEquals("Anna Kovács", r.cards[0].name); assertEquals(12, r.cards[0].balance); assertEquals(1, r.cards[0].history.size)
        assertTrue(!r.cards[1].found)
        val req = server.takeRequest()
        assertEquals("POST", req.method); assertEquals("/public/cards", req.path)
        assertTrue(req.getHeader("Content-Type")!!.startsWith("application/json"))
        assertNull(req.getHeader("Authorization"))
        assertEquals("""{"uids":["04:A2:3B:1C","04BBCCDD"]}""", req.body.readUtf8())
    }

    @Test fun aNotFoundCardIsASuccessWithFoundFalse() = runBlocking {
        server.enqueue(json(200, """{"cards":[{"uid":"04:BB:CC:DD","found":false}]}"""))
        val r = api.fetch(listOf("04:BB:CC:DD")) as FetchResult.Ok
        assertEquals(false, r.cards.single().found)
    }

    @Test fun tooManyTriesIsItsOwnResultWithFixedWords() = runBlocking {
        server.enqueue(json(429, """{"error":"Too many attempts. Try again in a few minutes."}"""))
        val r = api.fetch(listOf("04:A2:3B:1C"))
        assertEquals(FetchResult.TooManyTries, r)
        assertEquals("Too many tries, wait a few minutes", r.userMessage())
    }

    @Test fun badRequestShowsTheServersMessage() = runBlocking {
        server.enqueue(json(400, """{"error":"Between 1 and 10 cards."}"""))
        val r = api.fetch(listOf("x")) as FetchResult.ServerError
        assertEquals(400, r.status); assertEquals("Between 1 and 10 cards.", r.userMessage())
    }

    @Test fun serverErrorsShowTheirMessageOrAGenericOne() = runBlocking {
        server.enqueue(json(500, """{"error":"Something broke"}"""))
        assertEquals("Something broke", api.fetch(listOf("04:A2:3B:1C")).userMessage())
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>Bad gateway</html>"))
        assertEquals("Something went wrong (502).", api.fetch(listOf("04:A2:3B:1C")).userMessage())
    }

    @Test fun noConnectionIsOffline() = runBlocking {
        server.shutdown()
        val r = api.fetch(listOf("04:A2:3B:1C"))
        assertEquals(FetchResult.Offline, r)
        assertEquals("Can't reach the server.", r.userMessage())
    }

    @Test fun aBlankServerAddressIsOffline() = runBlocking {
        assertEquals(FetchResult.Offline, CardsApi("").fetch(listOf("04:A2:3B:1C")))
    }

    @Test fun aBodyThatIsNotTheExpectedJsonIsUnreadable() = runBlocking {
        server.enqueue(json(200, "<html>captive portal</html>"))
        assertEquals(FetchResult.Unreadable, api.fetch(listOf("04:A2:3B:1C")))
    }

    @Test fun aTrailingSlashInTheAddressIsFine() = runBlocking {
        server.enqueue(json(200, ok))
        val api2 = CardsApi(server.url("/").toString())
        assertTrue(api2.fetch(listOf("04:A2:3B:1C")) is FetchResult.Ok)
        assertEquals("/public/cards", server.takeRequest().path)
    }
}
