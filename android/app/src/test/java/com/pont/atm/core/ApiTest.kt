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
            terminalToken = "term-tok"; terminalName = "Bar 2"
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
        assertEquals("Bearer term-tok", req.getHeader("Authorization"))
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

    @Test fun aRevokedPhoneIsUnpairedOnTheNextRequest() = runBlocking {
        server.enqueue(json(401, """{"error":"This phone was revoked"}"""))
        val r = api.charge("04:A2:3B:1C", 8, "k")
        assertTrue(r is ChargeOutcome.Failed)
        assertNull(session.terminalToken)
    }

    @Test fun aRejectedHistoryRequestAlsoUnpairs() = runBlocking {
        server.enqueue(json(401, """{"error":"This phone was revoked"}"""))
        assertTrue(api.history().isFailure)
        assertNull(session.terminalToken)
    }

    @Test fun unpairForgetsTheTerminal() {
        api.unpair()
        assertNull(session.terminalToken); assertNull(session.terminalName)
    }

    @Test fun pairingSendsNoCredentials() = runBlocking {
        server.enqueue(json(200, """{"terminalToken":"tt2","terminal":{"id":"t2","name":"Entrance"}}"""))
        assertTrue(api.pair("123456", "Redmi", "0.1").isSuccess)
        assertNull(server.takeRequest().getHeader("Authorization"))
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

    @Test fun suggestCardPostsTheUidWithThePhonesToken() = runBlocking {
        server.enqueue(json(200, """{"ok":true}"""))
        assertTrue(api.suggestCard("04:EE:00:77").isSuccess)
        val req = server.takeRequest()
        assertEquals("POST", req.method); assertEquals("/card-suggestions", req.path)
        assertEquals("Bearer term-tok", req.getHeader("Authorization"))
        assertTrue("\"cardUid\":\"04:EE:00:77\"" in req.body.readUtf8())
    }

    @Test fun suggestCardSurfacesAnAlreadyRegisteredCard() = runBlocking {
        server.enqueue(json(409, """{"error":"That card is already registered.","code":"already_registered"}"""))
        assertEquals("That card is already registered.", api.suggestCard("04:A2:3B:1C").exceptionOrNull()?.message)
    }

    @Test fun suggestCardWithoutAConnectionSaysSo() = runBlocking {
        server.shutdown()
        assertEquals("No connection to the server.", api.suggestCard("04:EE:00:77").exceptionOrNull()?.message)
    }

    private val inBody = """{"action":"in","card":{"id":"c1","name":"Anna Kovács","photoUrl":"/cards/c1/photo","balance":46},
        "inAt":"2026-10-22T14:00:00.000Z","points":0,"raw":0,"cappedBy":null,"today":{"earned":0,"max":null}}"""
    private val outBody = """{"action":"out","card":{"id":"c1","name":"Anna Kovács","photoUrl":"/cards/c1/photo","balance":70},
        "inAt":"2026-10-22T14:00:00.000Z","outAt":"2026-10-22T14:40:00.000Z","minutes":40,"points":24,"raw":32,"cappedBy":"visit","today":{"earned":24,"max":100}}"""

    @Test fun configReadsTheModeAndName() = runBlocking {
        server.enqueue(json(200, """{"mode":"presence","name":"Door"}"""))
        assertEquals(TerminalConfig("presence", "Door", "toggle", null), api.config().getOrThrow())
        val req = server.takeRequest()
        assertEquals("/terminal/config", req.path); assertEquals("Bearer term-tok", req.getHeader("Authorization"))
    }

    @Test fun aCheckInIsMapped() = runBlocking {
        server.enqueue(json(200, inBody))
        val r = (api.presenceTap("04:A2:3B:1C", "k1") as PresenceOutcome.Done).result
        assertEquals("in", r.action); assertEquals("Anna Kovács", r.card.name); assertNull(r.today.max); assertNull(r.outAt)
        val req = server.takeRequest()
        assertEquals("/presence/tap", req.path); assertEquals("Bearer term-tok", req.getHeader("Authorization"))
        val body = req.body.readUtf8()
        assertTrue("\"cardUid\":\"04:A2:3B:1C\"" in body && "\"idempotencyKey\":\"k1\"" in body)
    }

    @Test fun aCheckOutCarriesTheStats() = runBlocking {
        server.enqueue(json(200, outBody))
        val r = (api.presenceTap("04:A2:3B:1C", "k2") as PresenceOutcome.Done).result
        assertEquals(40, r.minutes); assertEquals(24, r.points); assertEquals("visit", r.cappedBy)
        assertEquals(24, r.today.earned); assertEquals(100, r.today.max); assertEquals(70, r.card.balance)
    }

    @Test fun lockOutAndForgottenSignOutAreMapped() = runBlocking {
        server.enqueue(json(200, inBody.replace("\"in\"", "\"cooldown\"")))
        assertEquals("cooldown", (api.presenceTap("u", "k") as PresenceOutcome.Done).result.action)
        server.enqueue(json(200, inBody.replace("\"in\"", "\"expired_in\"").replace("\"points\"", "\"expiredMinutes\":780,\"points\"")))
        val r = (api.presenceTap("u", "k") as PresenceOutcome.Done).result
        assertEquals("expired_in", r.action); assertEquals(780, r.expiredMinutes)
    }

    @Test fun refusalsAreMapped() = runBlocking {
        server.enqueue(json(404, """{"error":"Card not registered","code":"unknown_card"}"""))
        assertEquals(PresenceOutcome.UnknownCard, api.presenceTap("u", "k"))
        server.enqueue(json(403, """{"error":"Card is blocked","code":"card_blocked","card":{"name":"Dóra","photoUrl":"/cards/c4/photo"}}"""))
        assertEquals(PresenceOutcome.Blocked("Dóra", "/cards/c4/photo"), api.presenceTap("u", "k"))
        server.enqueue(json(409, """{"error":"This terminal is not in check-in mode.","code":"wrong_mode"}"""))
        assertEquals(PresenceOutcome.WrongMode, api.presenceTap("u", "k"))
        server.enqueue(json(500, """{"error":"Something broke"}"""))
        assertEquals(PresenceOutcome.Failed("Something broke"), api.presenceTap("u", "k"))
    }

    @Test fun noConnectionIsMapped() = runBlocking {
        server.shutdown()
        assertEquals(PresenceOutcome.NoConnection, api.presenceTap("u", "k"))
    }

    @Test fun aRevokedPhoneIsUnpairedByACheckInTap() = runBlocking {
        server.enqueue(json(401, """{"error":"This phone was revoked"}"""))
        assertTrue(api.presenceTap("u", "k") is PresenceOutcome.Failed)
        assertNull(session.terminalToken)
    }

    @Test fun theModeIsRememberedAndDefaultsToAtm() {
        assertEquals("atm", InMemorySessionStore().mode)
        session.mode = "presence"; assertEquals("presence", session.mode)
    }

    @Test fun configCarriesThePointTypeAndZone() = runBlocking {
        server.enqueue(json(200, """{"mode":"presence","name":"Door","direction":"in","zoneName":"Gym"}"""))
        assertEquals(TerminalConfig("presence", "Door", "in", "Gym"), api.config().getOrThrow())
    }

    @Test fun aCheckInCarriesTheZone() = runBlocking {
        server.enqueue(json(200, """{"action":"in","card":{"id":"c1","name":"Anna","photoUrl":"/p","balance":46},"zone":{"id":"z1","name":"Gym"},
            "inAt":"2026-10-22T14:00:00.000Z","points":0,"raw":0,"cappedBy":null,"today":{"earned":0,"max":null}}"""))
        assertEquals(ZoneRef("z1", "Gym"), (api.presenceTap("u", "k") as PresenceOutcome.Done).result.zone)
    }

    @Test fun notCheckedInHasNoCheckInTime() = runBlocking {
        server.enqueue(json(200, """{"action":"not_in","card":{"id":"c1","name":"Anna","photoUrl":"/p","balance":46},"zone":{"id":"z1","name":"Gym"},
            "points":0,"raw":0,"cappedBy":null,"today":{"earned":0,"max":null}}"""))
        val r = (api.presenceTap("u", "k") as PresenceOutcome.Done).result
        assertEquals("not_in", r.action); assertNull(r.inAt)
    }

    @Test fun thePointTypeAndZoneAreRemembered() {
        val fresh = InMemorySessionStore()
        assertEquals("toggle", fresh.direction); assertNull(fresh.zoneName)
        session.direction = "out"; session.zoneName = "Gym"
        assertEquals("out", session.direction); assertEquals("Gym", session.zoneName)
    }
}
