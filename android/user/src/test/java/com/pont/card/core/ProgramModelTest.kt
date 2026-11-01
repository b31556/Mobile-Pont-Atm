package com.pont.card.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ProgramModelTest {
    private class Fake(var next: ProgramFetch) : ProgramFetcher {
        var calls = 0
        override suspend fun fetch(): ProgramFetch { calls++; return next }
    }

    private val kv = InMemoryKeyValueStore()
    private fun scope() = TestScope(UnconfinedTestDispatcher())
    private fun event(id: String, from: String = "09:00", to: String = "10:00") =
        ProgramEvent(id, "thu", id, "1", from, to, "rate", rate = 8, block = 12)
    private fun doc(vararg events: ProgramEvent) =
        ProgramDoc("T", listOf(ProgramDay("thu", "Thu", "2026-10-22")), ProgramGoal(90, "thu", 50), events.toList())
    private fun model(fetch: ProgramFetch, f: Fake = Fake(fetch)) = ProgramModel(ProgramRepository(kv, f), PlanStore(kv), scope())

    @Test fun startsEmptyWithNothingSaved() {
        val m = model(ProgramFetch.Offline)
        assertNull(m.state.value.doc); assertTrue(m.state.value.likes.isEmpty()); assertTrue(m.state.value.placed.isEmpty())
    }

    @Test fun refreshShowsAndSavesTheProgram() {
        val m = model(ProgramFetch.Ok(doc(event("a"), event("b"))))
        m.refresh()
        assertEquals(2, m.state.value.doc!!.events.size); assertFalse(m.state.value.loading); assertFalse(m.state.value.offline)
        // a new run of the app starts from the saved copy, before it asks the server
        assertEquals(2, model(ProgramFetch.Offline).state.value.doc!!.events.size)
    }

    @Test fun offlineKeepsTheSavedProgramAndSaysSo() {
        model(ProgramFetch.Ok(doc(event("a")))).refresh()
        val m = model(ProgramFetch.Offline); m.refresh()
        assertTrue(m.state.value.offline); assertEquals(1, m.state.value.doc!!.events.size); assertFalse(m.state.value.loading)
    }

    @Test fun aFailedAskKeepsTheSavedProgramAndTellsWhy() {
        model(ProgramFetch.Ok(doc(event("a")))).refresh()
        val m = model(ProgramFetch.Failed("Too many tries")); m.refresh()
        assertEquals("Too many tries", m.state.value.problem); assertEquals(1, m.state.value.doc!!.events.size)
    }

    @Test fun anEmptyProgramIsNotSaved() {
        model(ProgramFetch.Ok(doc())).refresh()
        assertNull(ProgramRepository(kv, Fake(ProgramFetch.Offline)).cached())
    }

    @Test fun likesAndPlansSurviveARestart() {
        val m = model(ProgramFetch.Ok(doc(event("a"), event("b")))); m.refresh()
        m.toggleLike("a"); m.place("b", Placement(540, 36))
        val again = model(ProgramFetch.Offline)
        assertEquals(setOf("a"), again.state.value.likes); assertEquals(Placement(540, 36), again.state.value.placed["b"])
        again.toggleLike("a"); again.remove("b")
        val third = model(ProgramFetch.Offline)
        assertTrue(third.state.value.likes.isEmpty()); assertTrue(third.state.value.placed.isEmpty())
    }

    @Test fun eventsTheProgramNoLongerHasAreForgotten() {
        val m = model(ProgramFetch.Ok(doc(event("a"), event("b")))); m.refresh()
        m.toggleLike("a"); m.toggleLike("b"); m.place("a", Placement(540, 60)); m.place("b", Placement(560, 30))
        val next = model(ProgramFetch.Ok(doc(event("b")))); next.refresh()
        assertEquals(setOf("b"), next.state.value.likes); assertEquals(setOf("b"), next.state.value.placed.keys)
    }

    @Test fun plannedPointsAddUpPerDay() {
        val m = model(ProgramFetch.Ok(doc(event("a"), event("b", "10:00", "11:00")))); m.refresh()
        m.place("a", Placement(540, 60)); m.place("b", Placement(600, 24))
        assertEquals(40 + 16, m.state.value.plannedPoints())
        assertEquals(56, m.state.value.plannedPoints("thu")); assertEquals(0, m.state.value.plannedPoints("wed"))
        assertEquals(listOf("a", "b"), m.state.value.placedOn("thu").map { it.event.id })
        assertNotNull(m.state.value.event("a")); assertNull(m.state.value.event("zzz"))
    }

    @Test fun skippingAnEventLeavesItOutUntilBroughtBack() {
        val m = model(ProgramFetch.Ok(doc(event("a"), event("b")))); m.refresh()
        m.skip("a"); m.skip("b")
        assertEquals(setOf("a", "b"), model(ProgramFetch.Offline).state.value.skipped)     // kept across a restart
        m.unskipAll()
        assertTrue(m.state.value.skipped.isEmpty()); assertTrue(model(ProgramFetch.Offline).state.value.skipped.isEmpty())
    }

    @Test fun skippedEventsTheProgramNoLongerHasAreForgotten() {
        val m = model(ProgramFetch.Ok(doc(event("a"), event("b")))); m.refresh()
        m.skip("a"); m.skip("b")
        val next = model(ProgramFetch.Ok(doc(event("b")))); next.refresh()
        assertEquals(setOf("b"), next.state.value.skipped)
    }

    @Test fun aDamagedSavedCopyIsIgnored() {
        kv.put("program", "{not json"); kv.put("plan", "also not json")
        val m = model(ProgramFetch.Offline)
        assertNull(m.state.value.doc); assertTrue(m.state.value.likes.isEmpty())
    }
}
