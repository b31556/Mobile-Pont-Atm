package com.pont.atm.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChargeFlowTest {
    private val ok = ChargeOutcome.Success(
        TxInfo(1, 8, "2026-10-22T14:32:00.000Z", "Bar 2"),
        CardInfo("c1", "Anna Kovács", "/cards/c1/photo", 46, 54),
    )

    private class Fake(var next: ChargeOutcome, val gate: CompletableDeferred<Unit>? = null) : ChargeApi {
        val calls = mutableListOf<Triple<String, Int, String>>()
        override suspend fun charge(uid: String, amount: Int, key: String): ChargeOutcome {
            calls += Triple(uid, amount, key)
            gate?.await()
            return next
        }
    }

    private fun flow(api: ChargeApi): ChargeFlow { var n = 0; return ChargeFlow(api) { "key-${++n}" } }

    @Test fun startMovesToWaitingForCard() {
        val f = flow(Fake(ok)); f.start(8)
        assertEquals(FlowState.WaitingForCard(8), f.state.value)
    }

    @Test fun aTagWhileIdleIsIgnored() = runTest {
        val api = Fake(ok); val f = flow(api)
        f.onTag("04:A2:3B:1C")
        assertEquals(FlowState.Idle, f.state.value); assertTrue(api.calls.isEmpty())
    }

    @Test fun aSuccessfulTagEndsInDoneWithTheOutcome() = runTest {
        val api = Fake(ok); val f = flow(api); f.start(8)
        f.onTag("04:A2:3B:1C")
        assertEquals(FlowState.Done(8, ok, "04:A2:3B:1C"), f.state.value)
        assertEquals(listOf(Triple("04:A2:3B:1C", 8, "key-1")), api.calls)
    }

    @Test fun theStateIsSendingWhileTheServerIsBusy() = runTest {
        val gate = CompletableDeferred<Unit>(); val f = flow(Fake(ok, gate)); f.start(8)
        val job = launch { f.onTag("04:A2:3B:1C") }
        testScheduler.runCurrent()
        assertEquals(FlowState.Sending(8, "04:A2:3B:1C"), f.state.value)
        gate.complete(Unit); job.join()
        assertTrue(f.state.value is FlowState.Done)
    }

    @Test fun twoTapsInARowCallTheApiOnce() = runTest {
        val gate = CompletableDeferred<Unit>(); val api = Fake(ok, gate); val f = flow(api); f.start(8)
        val a = launch { f.onTag("04:A2:3B:1C") }
        val b = launch { f.onTag("04:A2:3B:1C") }
        testScheduler.runCurrent(); gate.complete(Unit); a.join(); b.join()
        assertEquals(1, api.calls.size)
    }

    @Test fun retryAfterNoConnectionReusesTheKey() = runTest {
        val api = Fake(ChargeOutcome.NoConnection); val f = flow(api); f.start(8)
        f.onTag("04:A2:3B:1C"); f.retry()
        assertEquals(FlowState.WaitingForCard(8), f.state.value)
        api.next = ok; f.onTag("04:A2:3B:1C")
        assertEquals(listOf("key-1", "key-1"), api.calls.map { it.third })
    }

    @Test fun retryAfterAServerFailureAlsoReusesTheKey() = runTest {
        val api = Fake(ChargeOutcome.Failed("boom")); val f = flow(api); f.start(8)
        f.onTag("04:A2:3B:1C"); f.retry(); f.onTag("04:A2:3B:1C")
        assertEquals(listOf("key-1", "key-1"), api.calls.map { it.third })
    }

    @Test fun retryAfterBlockedUsesANewKey() = runTest {
        val api = Fake(ChargeOutcome.Blocked("Dóra", "/p")); val f = flow(api); f.start(8)
        f.onTag("04:55:0A:B3"); f.retry(); f.onTag("04:A2:3B:1C")
        assertEquals(listOf("key-1", "key-2"), api.calls.map { it.third })
    }

    @Test fun aDifferentCardAfterNoConnectionIsANewCharge() = runTest {
        val api = Fake(ChargeOutcome.NoConnection); val f = flow(api); f.start(8)
        f.onTag("04:A2:3B:1C"); f.retry(); f.onTag("04:7F:91:E2")
        assertEquals(listOf("key-1", "key-2"), api.calls.map { it.third })
    }

    @Test fun cancelWhileWaitingReturnsToIdle() {
        val f = flow(Fake(ok)); f.start(8); f.cancel()
        assertEquals(FlowState.Idle, f.state.value)
    }

    @Test fun cancelWhileSendingIsIgnored() = runTest {
        val gate = CompletableDeferred<Unit>(); val f = flow(Fake(ok, gate)); f.start(8)
        val job = launch { f.onTag("04:A2:3B:1C") }
        testScheduler.runCurrent(); f.cancel()
        assertTrue(f.state.value is FlowState.Sending)
        gate.complete(Unit); job.join()
    }

    @Test fun resetAfterDoneReturnsToIdle() = runTest {
        val f = flow(Fake(ok)); f.start(8); f.onTag("04:A2:3B:1C"); f.reset()
        assertEquals(FlowState.Idle, f.state.value)
    }

    @Test fun aNewStartAfterSuccessGetsANewKey() = runTest {
        val api = Fake(ok); val f = flow(api)
        f.start(8); f.onTag("04:A2:3B:1C"); f.reset(); f.start(8); f.onTag("04:A2:3B:1C")
        assertEquals(listOf("key-1", "key-2"), api.calls.map { it.third })
    }

    @Test fun aCancelledCallerStillLetsTheChargeFinish() = runTest {
        // The Activity (and its coroutine scope) can be recreated while the request is in flight.
        val gate = CompletableDeferred<Unit>(); val f = flow(Fake(ok, gate)); f.start(8)
        val job = launch { f.onTag("04:A2:3B:1C") }
        testScheduler.runCurrent()
        job.cancel()
        gate.complete(Unit); testScheduler.advanceUntilIdle()
        assertEquals(FlowState.Done(8, ok, "04:A2:3B:1C"), f.state.value)
    }

    @Test fun anUnexpectedExceptionBecomesAFailureNotAStuckSendingState() = runTest {
        val boom = object : ChargeApi { override suspend fun charge(uid: String, amount: Int, key: String): ChargeOutcome = throw IllegalStateException("boom") }
        val f = flow(boom); f.start(8)
        f.onTag("04:A2:3B:1C")
        val done = f.state.value as FlowState.Done
        assertTrue(done.outcome is ChargeOutcome.Failed)
        f.retry()
        assertEquals(FlowState.WaitingForCard(8), f.state.value)
    }

    @Test fun oneMoreLikeThisStartsANewChargeStraightFromTheResult() = runTest {
        val api = Fake(ok); val f = flow(api)
        f.start(8); f.onTag("04:A2:3B:1C")
        f.start(8) // "One more like this" on the result screen: no trip back to the keypad
        assertEquals(FlowState.WaitingForCard(8), f.state.value)
        f.onTag("04:7F:91:E2")
        assertEquals(listOf("key-1", "key-2"), api.calls.map { it.third })
        assertEquals("04:7F:91:E2", api.calls.last().first)
    }

    @Test fun startIsIgnoredWhileARequestIsInFlight() = runTest {
        val gate = CompletableDeferred<Unit>(); val f = flow(Fake(ok, gate)); f.start(8)
        val job = launch { f.onTag("04:A2:3B:1C") }
        testScheduler.runCurrent()
        f.start(20)
        assertTrue(f.state.value is FlowState.Sending)
        gate.complete(Unit); job.join()
        assertEquals(8, (f.state.value as FlowState.Done).amount)
    }
}
