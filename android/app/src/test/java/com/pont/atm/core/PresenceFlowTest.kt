package com.pont.atm.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PresenceFlowTest {
    private fun result(action: String = "in") = PresenceResult(
        action, PresenceCard("c1", "Anna Kovács", "/cards/c1/photo", 46), "2026-10-22T14:00:00.000Z", today = PresenceToday(0, null),
    )
    private val done = PresenceOutcome.Done(result())

    private class Fake(var next: PresenceOutcome, val gate: CompletableDeferred<Unit>? = null) : PresenceApi {
        val calls = mutableListOf<Pair<String, String>>()
        override suspend fun presenceTap(uid: String, key: String): PresenceOutcome {
            calls += uid to key
            gate?.await()
            return next
        }
    }

    private var clock = 0L
    private fun flow(api: PresenceApi): PresenceFlow { var n = 0; return PresenceFlow(api, { "key-${++n}" }, { clock }) }

    @Test fun aTapShowsTheResult() = runTest {
        val api = Fake(done); val f = flow(api)
        f.onTag("04:A2:3B:1C")
        assertEquals(PresenceState.Showing("04:A2:3B:1C", done, 0L), f.state.value)
        assertEquals(listOf("04:A2:3B:1C" to "key-1"), api.calls)
    }

    @Test fun theStateIsSendingWhileTheServerThinks() = runTest {
        val gate = CompletableDeferred<Unit>(); val f = flow(Fake(done, gate))
        val job = launch { f.onTag("04:A2:3B:1C") }
        testScheduler.runCurrent()
        assertEquals(PresenceState.Sending("04:A2:3B:1C"), f.state.value)
        gate.complete(Unit); job.join()
        assertTrue(f.state.value is PresenceState.Showing)
    }

    @Test fun aTapWhileSendingIsIgnored() = runTest {
        val gate = CompletableDeferred<Unit>(); val api = Fake(done, gate); val f = flow(api)
        val a = launch { f.onTag("04:A2:3B:1C") }
        testScheduler.runCurrent()
        val b = launch { f.onTag("04:7F:91:E2") }
        testScheduler.runCurrent(); gate.complete(Unit); a.join(); b.join()
        assertEquals(1, api.calls.size)
    }

    @Test fun theNextCardReplacesTheResultAtOnce() = runTest {
        val api = Fake(done); val f = flow(api)
        f.onTag("04:A2:3B:1C")
        f.onTag("04:7F:91:E2")
        assertEquals("04:7F:91:E2", (f.state.value as PresenceState.Showing).uid)
        assertEquals(2, api.calls.size)
    }

    @Test fun theSameCardReadTwiceInARowIsOneTap() = runTest {
        val api = Fake(done); val f = flow(api)
        clock = 0; f.onTag("04:A2:3B:1C")
        clock = 1_000; f.onTag("04:A2:3B:1C")
        assertEquals(1, api.calls.size)
        clock = 3_500; f.onTag("04:A2:3B:1C")
        assertEquals(2, api.calls.size)
    }

    @Test fun aDifferentCardIsNeverHeldBackByTheSameCardGuard() = runTest {
        val api = Fake(done); val f = flow(api)
        clock = 0; f.onTag("04:A2:3B:1C"); clock = 100; f.onTag("04:7F:91:E2")
        assertEquals(2, api.calls.size)
    }

    @Test fun everyTapGetsItsOwnKeyAfterAnAnswer() = runTest {
        val api = Fake(done); val f = flow(api)
        clock = 0; f.onTag("04:A2:3B:1C"); clock = 10_000; f.onTag("04:A2:3B:1C")
        assertEquals(listOf("key-1", "key-2"), api.calls.map { it.second })
    }

    @Test fun afterALostConnectionTheSameCardKeepsItsKey() = runTest {
        val api = Fake(PresenceOutcome.NoConnection); val f = flow(api)
        clock = 0; f.onTag("04:A2:3B:1C")
        clock = 10_000; api.next = done; f.onTag("04:A2:3B:1C")
        assertEquals(listOf("key-1", "key-1"), api.calls.map { it.second })
        clock = 20_000; f.onTag("04:A2:3B:1C")
        assertEquals("key-2", api.calls.last().second)
    }

    @Test fun aServerFailureAlsoKeepsTheKey() = runTest {
        val api = Fake(PresenceOutcome.Failed("boom")); val f = flow(api)
        clock = 0; f.onTag("04:A2:3B:1C"); clock = 10_000; f.onTag("04:A2:3B:1C")
        assertEquals(listOf("key-1", "key-1"), api.calls.map { it.second })
    }

    @Test fun aDifferentCardOrALongPauseStartsFresh() = runTest {
        val api = Fake(PresenceOutcome.NoConnection); val f = flow(api)
        clock = 0; f.onTag("04:A2:3B:1C")
        clock = 10_000; f.onTag("04:7F:91:E2")
        clock = 100_000; f.onTag("04:7F:91:E2")
        assertEquals(listOf("key-1", "key-2", "key-3"), api.calls.map { it.second })
    }

    @Test fun clearReturnsToIdleOnlyFromAResult() = runTest {
        val f = flow(Fake(done))
        f.clear(); assertEquals(PresenceState.Idle, f.state.value)
        f.onTag("04:A2:3B:1C"); f.clear()
        assertEquals(PresenceState.Idle, f.state.value)
    }

    @Test fun clearDuringSendingIsIgnored() = runTest {
        val gate = CompletableDeferred<Unit>(); val f = flow(Fake(done, gate))
        val job = launch { f.onTag("04:A2:3B:1C") }
        testScheduler.runCurrent(); f.clear()
        assertTrue(f.state.value is PresenceState.Sending)
        gate.complete(Unit); job.join()
    }

    @Test fun aCancelledCallerStillGetsTheResultInTheState() = runTest {
        val gate = CompletableDeferred<Unit>(); val f = flow(Fake(done, gate))
        val job = launch { f.onTag("04:A2:3B:1C") }
        testScheduler.runCurrent(); job.cancel(); gate.complete(Unit); testScheduler.advanceUntilIdle()
        assertTrue(f.state.value is PresenceState.Showing)
    }

    @Test fun anUnexpectedExceptionBecomesAFailure() = runTest {
        val f = flow(object : PresenceApi { override suspend fun presenceTap(uid: String, key: String): PresenceOutcome = throw IllegalStateException("boom") })
        f.onTag("04:A2:3B:1C")
        assertTrue(((f.state.value as PresenceState.Showing).outcome) is PresenceOutcome.Failed)
    }
}
