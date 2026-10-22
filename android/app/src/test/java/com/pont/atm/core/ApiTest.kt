package com.pont.atm.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ApiTest {
    private lateinit var server: MockWebServer
    private lateinit var session: InMemorySessionStore
    private lateinit var api: PontApi

    @Before fun setUp() {
        server = MockWebServer().also { it.start() }
        session = InMemorySessionStore().apply {
            baseUrl = server.url("/").toString().trimEnd('/')
            terminalToken = "term-tok"; operatorToken = "op-tok"
        }
        api = PontApi(session)
    }
    @After fun tearDown() { runCatching { server.shutdown() } }

    private fun json(code: Int, body: String) =
        MockResponse().setResponseCode(code).setHeader("content-type", "application/json").setBody(body)

    private val successBody = """{"transaction":{"id":1043,"amount":8,"createdAt":"2026-10-22T14:32:00.000Z","terminal":"Bar 2"},
        "card":{"id":"c1","name":"Anna Kovács","photoUrl":"/cards/c1/photo","balanceBefore":46,"balance":54}}"""

    @Test fun chargeSuccessMapsHolderAndBalances() = runBlocking {
        server.enqueue(json(200, successBody))
        val r = api.charge("04:A2:3B:1C", 8, "key-1")
        assertTrue(r is ChargeOutcome.Success)
        r as ChargeOutcome.Success
        assertEquals("Anna Kovács", r.card.name)
        assertEquals(46, r.card.balanceBefore); assertEquals(54, r.card.balance)
        assertEquals(1043L, r.tx.id)
        val req = server.takeRequest()
        assertEquals("/charges", req.path)
        assertEquals("Bearer op-tok", req.getHeader("Authorization"))
        assertTrue(req.body.readUtf8().let { "\"cardUid\":\"04:A2:3B:1C\"" in it && "\"amount\":8" in it && "\"idempotencyKey\":\"key-1\"" in it })
    }

    @Test fun unknownCardMapsToUnknownCard() = runBlocking {
        server.enqueue(json(404, """{"error":"Card not registered","code":"unknown_card"}"""))
        assertEquals(ChargeOutcome.UnknownCard, api.charge("04:EE:00:77", 8, "k"))
    }

    @Test fun blockedCardMapsToBlockedWithHolder() = runBlocking {
        server.enqueue(json(403, """{"error":"Card is blocked","code":"card_blocked","card":{"name":"Dóra Tóth","photoUrl":"/cards/c4/photo"}}"""))
        val r = api.charge("04:55:0A:B3", 8, "k")
        assertEquals(ChargeOutcome.Blocked("Dóra Tóth", "/cards/c4/photo"), r)
    }

    @Test fun otherServerErrorsBecomeFailedWithTheServerMessage() = runBlocking {
        server.enqueue(json(400, """{"error":"Amount must be a whole number from 1 to 9999","code":"bad_amount"}"""))
        assertEquals(ChargeOutcome.Failed("Amount must be a whole number from 1 to 9999"), api.charge("04:A2:3B:1C", 0, "k"))
    }

    @Test fun unreachableServerMapsToNoConnection() = runBlocking {
        server.shutdown()
        assertEquals(ChargeOutcome.NoConnection, api.charge("04:A2:3B:1C", 8, "k"))
    }

    @Test fun a401ClearsTheOperatorToken() = runBlocking {
        server.enqueue(json(401, """{"error":"Sign in again"}"""))
        val r = api.charge("04:A2:3B:1C", 8, "k")
        assertTrue(r is ChargeOutcome.Failed)
        assertNull(session.operatorToken)
        assertEquals("term-tok", session.terminalToken)
    }

    @Test fun loginSendsTheTerminalTokenAndStoresTheSession() = runBlocking {
        server.enqueue(json(200, """{"token":"new-op","user":{"id":"u1","name":"Eszter","role":"operator"}}"""))
        session.operatorToken = null
        val r = api.login("eszter@pont.example", "pw")
        assertEquals("Eszter", r.getOrThrow().name)
        assertEquals("new-op", session.operatorToken); assertEquals("Eszter", session.operatorName)
        val body = server.takeRequest().body.readUtf8()
        assertTrue("\"terminalToken\":\"term-tok\"" in body && "\"email\":\"eszter@pont.example\"" in body)
    }

    @Test fun wrongPasswordIsAFailureWithTheServerMessage() = runBlocking {
        server.enqueue(json(401, """{"error":"Wrong email or password"}"""))
        session.operatorToken = null
        assertEquals("Wrong email or password", api.login("a@b.c", "x").exceptionOrNull()?.message)
    }

    @Test fun pairStoresTheTerminalTokenAndName() = runBlocking {
        server.enqueue(json(200, """{"terminalToken":"tt","terminal":{"id":"t1","name":"Bar 2"}}"""))
        session.terminalToken = null
        assertTrue(api.pair("895211", "Redmi 12", "0.1.0").isSuccess)
        assertEquals("tt", session.terminalToken); assertEquals("Bar 2", session.terminalName)
        assertTrue("\"code\":\"895211\"" in server.takeRequest().body.readUtf8())
    }

    @Test fun historyParsesRows() = runBlocking {
        server.enqueue(json(200, """[{"id":1043,"type":"give","amount":8,"status":"stornoed","ref":null,"createdAt":"2026-10-22T14:32:00.000Z",
            "terminal":"Bar 2","operator":"Eszter","card":{"id":"c1","name":"Anna Kovács","photoUrl":"/cards/c1/photo"}}]"""))
        val rows = api.history().getOrThrow()
        assertEquals(1, rows.size)
        assertEquals("stornoed", rows[0].status); assertEquals("Anna Kovács", rows[0].card.name)
    }

    @Test fun stornoRefusalSurfacesTheServerMessage() = runBlocking {
        server.enqueue(json(400, """{"error":"Card has fewer points than this storno.","code":"would_go_negative"}"""))
        val r = api.storno(1043)
        assertEquals("Card has fewer points than this storno.", r.exceptionOrNull()?.message)
        assertEquals("/transactions/1043/storno", server.takeRequest().path)
    }

    @Test fun stornoSuccessReturnsTheNewBalance() = runBlocking {
        server.enqueue(json(200, """{"transaction":{"id":1044,"amount":-8,"createdAt":"2026-10-22T14:40:00.000Z","terminal":"Bar 2"},
            "card":{"id":"c1","name":"Anna Kovács","photoUrl":"/cards/c1/photo","balanceBefore":54,"balance":46}}"""))
        assertEquals(46, api.storno(1043).getOrThrow().card.balance)
    }

    @Test fun savePresetsPutsValuesAndSwitch() = runBlocking {
        server.enqueue(json(200, """{"values":[4,12],"instantPreset":false}"""))
        val r = api.savePresets(listOf(12, 4), false).getOrThrow()
        assertEquals(listOf(4, 12), r.values); assertEquals(false, r.instantPreset)
        val req = server.takeRequest()
        assertEquals("PUT", req.method)
        assertTrue("\"values\":[12,4]" in req.body.readUtf8())
    }

    @Test fun photoUrlJoinsTheBaseUrl() {
        assertEquals(session.baseUrl + "/cards/c1/photo", api.photoUrl("/cards/c1/photo"))
    }
}
