package com.pont.atm.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class InfoFlowTest {
    private val done = InfoOutcome.Done(InfoResult("info", InfoCard("c1", "Anna Kovács", "/cards/c1/photo", 46), listOf(InfoRow("2026-10-22T14:00:00.000Z", "fixed", 8, "Bar 2"))))

    private class Fake(var next: InfoOutcome, val gate: CompletableDeferred<Unit>? = null) : InfoApi {
        val calls = mutableListOf<String>()
        override suspend fun infoTap(uid: String): InfoOutcome {
            calls += uid
            gate?.await()
            return next
        }
    }

    private var clock = 0L
    private fun flow(api: InfoApi) = InfoFlow(api) { clock }

    @Test fun aTapShowsTheResult() = runTest {
        val api = Fake(done); val f = flow(api)
        f.onTag("04:A2:3B:1C")
        assertEquals(InfoState.Showing("04:A2:3B:1C", done, 0L), f.state.value)
        assertEquals(listOf("04:A2:3B:1C"), api.calls)
    }

    @Test fun theStateIsSendingWhileTheServerThinks() = runTest {
        val gate = CompletableDeferred<Unit>(); val f = flow(Fake(done, gate))
        val job = launch { f.onTag("04:A2:3B:1C") }
        testScheduler.runCurrent()
        assertEquals(InfoState.Sending("04:A2:3B:1C"), f.state.value)
        gate.complete(Unit); job.join()
        assertTrue(f.state.value is InfoState.Showing)
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
        assertEquals("04:7F:91:E2", (f.state.value as InfoState.Showing).uid)
        assertEquals(2, api.calls.size)
    }

    @Test fun theSameCardReadTwiceInARowIsOneTap() = runTest {
        val api = Fake(done); val f = flow(api)
        clock = 0; f.onTag("04:A2:3B:1C")
        clock = 500; f.onTag("04:A2:3B:1C")
        assertEquals(1, api.calls.size)
        clock = InfoFlow.SAME_CARD_GUARD_MS + 1; f.onTag("04:A2:3B:1C")
        assertEquals(2, api.calls.size)
    }

    @Test fun aDifferentCardIsNeverHeldBackByTheSameCardGuard() = runTest {
        val api = Fake(done); val f = flow(api)
        clock = 0; f.onTag("04:A2:3B:1C"); clock = 100; f.onTag("04:7F:91:E2")
        assertEquals(2, api.calls.size)
    }

    @Test fun refusalsAndFailuresAreShownAsTheyAre() = runTest {
        for (o in listOf(InfoOutcome.UnknownCard, InfoOutcome.Blocked("Dóra", "/p"), InfoOutcome.NoConnection, InfoOutcome.WrongMode, InfoOutcome.Failed("boom"))) {
            val f = flow(Fake(o)); f.onTag("04:A2:3B:1C")
            assertEquals(o, (f.state.value as InfoState.Showing).outcome)
        }
    }

    @Test fun aFailedLookupCanBeTappedAgainAtOnceWithNoKeyNeeded() = runTest {
        val api = Fake(InfoOutcome.NoConnection); val f = flow(api)
        clock = 0; f.onTag("04:A2:3B:1C")
        clock = 5_000; api.next = done; f.onTag("04:A2:3B:1C")
        assertEquals(done, (f.state.value as InfoState.Showing).outcome)
    }

    @Test fun clearReturnsToIdleOnlyFromAResult() = runTest {
        val f = flow(Fake(done))
        f.clear(); assertEquals(InfoState.Idle, f.state.value)
        f.onTag("04:A2:3B:1C"); f.clear()
        assertEquals(InfoState.Idle, f.state.value)
    }

    @Test fun clearDuringSendingIsIgnored() = runTest {
        val gate = CompletableDeferred<Unit>(); val f = flow(Fake(done, gate))
        val job = launch { f.onTag("04:A2:3B:1C") }
        testScheduler.runCurrent(); f.clear()
        assertTrue(f.state.value is InfoState.Sending)
        gate.complete(Unit); job.join()
    }

    @Test fun aCancelledCallerStillGetsTheResultInTheState() = runTest {
        val gate = CompletableDeferred<Unit>(); val f = flow(Fake(done, gate))
        val job = launch { f.onTag("04:A2:3B:1C") }
        testScheduler.runCurrent(); job.cancel(); gate.complete(Unit); testScheduler.advanceUntilIdle()
        assertTrue(f.state.value is InfoState.Showing)
    }

    @Test fun anUnexpectedExceptionBecomesAFailure() = runTest {
        val f = flow(InfoApi { throw IllegalStateException("boom") })
        f.onTag("04:A2:3B:1C")
        assertTrue(((f.state.value as InfoState.Showing).outcome) is InfoOutcome.Failed)
    }
}
