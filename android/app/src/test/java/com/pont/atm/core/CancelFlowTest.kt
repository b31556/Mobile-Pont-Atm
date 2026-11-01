package com.pont.atm.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CancelFlowTest {
    private val card = PresenceCard("c1", "Anna Kovács", "/p", 46)
    private val cancelled = CancelResult("cancelled_out", 24, card, ZoneRef("z1", "Gym"))
    private val out = CancelKey(77, "out")
    private val inn = CancelKey(77, "in")

    private class Fake(var next: CancelOutcome, val gate: CompletableDeferred<Unit>? = null) : PresenceCancelApi {
        val calls = mutableListOf<Pair<Long, String>>()
        override suspend fun cancelSession(sessionId: Long, expect: String): CancelOutcome {
            calls += sessionId to expect
            gate?.await()
            return next
        }
    }

    @Test fun startsIdle() = assertEquals(CancelState.Idle, CancelFlow(Fake(CancelOutcome.Done(cancelled))).state.value)

    @Test fun askingOpensTheConfirmationAndKeepClosesIt() {
        val f = CancelFlow(Fake(CancelOutcome.Done(cancelled)))
        f.ask(out); assertEquals(CancelState.Asking(out), f.state.value)
        f.dismiss(); assertEquals(CancelState.Idle, f.state.value)
    }

    @Test fun confirmingSendsTheSessionAndExpectationOnce() = runTest {
        val api = Fake(CancelOutcome.Done(cancelled)); val f = CancelFlow(api)
        f.ask(out); f.confirm(out)
        assertEquals(CancelState.Done(out, cancelled), f.state.value)
        assertEquals(listOf(77L to "out"), api.calls)
    }

    @Test fun nothingIsSentWithoutAskingFirst() = runTest {
        val api = Fake(CancelOutcome.Done(cancelled)); val f = CancelFlow(api)
        f.confirm(out)
        assertTrue(api.calls.isEmpty()); assertEquals(CancelState.Idle, f.state.value)
    }

    @Test fun confirmingAnotherVisitThanTheOneAskedAboutSendsNothing() = runTest {
        val api = Fake(CancelOutcome.Done(cancelled)); val f = CancelFlow(api)
        f.ask(out); f.confirm(inn)
        assertTrue(api.calls.isEmpty()); assertEquals(CancelState.Asking(out), f.state.value)
    }

    @Test fun theStateIsSendingWhileTheServerThinks() = runTest {
        val gate = CompletableDeferred<Unit>(); val f = CancelFlow(Fake(CancelOutcome.Done(cancelled), gate))
        f.ask(out)
        val job = launch { f.confirm(out) }
        testScheduler.runCurrent()
        assertEquals(CancelState.Sending(out), f.state.value)
        gate.complete(Unit); job.join()
        assertTrue(f.state.value is CancelState.Done)
    }

    @Test fun aDoubleTapSendsOneCancel() = runTest {
        val gate = CompletableDeferred<Unit>(); val api = Fake(CancelOutcome.Done(cancelled), gate); val f = CancelFlow(api)
        f.ask(out)
        val a = launch { f.confirm(out) }
        testScheduler.runCurrent()
        val b = launch { f.confirm(out) }
        f.ask(out) // the button is gone while sending, but even a stray ask changes nothing
        f.dismiss(); f.reset()
        testScheduler.runCurrent(); gate.complete(Unit); a.join(); b.join()
        assertEquals(1, api.calls.size)
        assertTrue(f.state.value is CancelState.Done)
    }

    @Test fun afterACancelItCantBeStartedAgain() = runTest {
        val api = Fake(CancelOutcome.Done(cancelled)); val f = CancelFlow(api)
        f.ask(out); f.confirm(out)
        f.ask(out); f.confirm(out)
        assertEquals(1, api.calls.size); assertTrue(f.state.value is CancelState.Done)
    }

    @Test fun aRefusalKeepsTheButtonsAndShowsTheServersMessage() = runTest {
        val api = Fake(CancelOutcome.Failed("Card has fewer points than this check-out paid.", "would_go_negative")); val f = CancelFlow(api)
        f.ask(out); f.confirm(out)
        assertEquals(CancelState.Failed(out, "Card has fewer points than this check-out paid."), f.state.value)
        // The buttons are still there: it can be asked again and tried again.
        api.next = CancelOutcome.Done(cancelled)
        f.ask(out); assertEquals(CancelState.Asking(out), f.state.value)
        f.confirm(out); assertTrue(f.state.value is CancelState.Done); assertEquals(2, api.calls.size)
    }

    @Test fun noConnectionIsAFailureThatCanBeRetried() = runTest {
        val f = CancelFlow(Fake(CancelOutcome.NoConnection))
        f.ask(inn); f.confirm(inn)
        val s = f.state.value as CancelState.Failed
        assertTrue(s.message.startsWith("No connection"))
        f.ask(inn); assertEquals(CancelState.Asking(inn), f.state.value)
    }

    @Test fun anUnexpectedExceptionBecomesAFailure() = runTest {
        val f = CancelFlow(PresenceCancelApi { _, _ -> throw IllegalStateException("boom") })
        f.ask(out); f.confirm(out)
        assertTrue(f.state.value is CancelState.Failed)
    }

    @Test fun aCancelledCallerStillGetsTheAnswerInTheState() = runTest {
        val gate = CompletableDeferred<Unit>(); val f = CancelFlow(Fake(CancelOutcome.Done(cancelled), gate))
        f.ask(out)
        val job = launch { f.confirm(out) }
        testScheduler.runCurrent(); job.cancel(); gate.complete(Unit); testScheduler.advanceUntilIdle()
        assertTrue(f.state.value is CancelState.Done)
    }

    @Test fun resetForgetsAnythingButARunningRequest() = runTest {
        val f = CancelFlow(Fake(CancelOutcome.Done(cancelled)))
        f.ask(out); f.reset(); assertEquals(CancelState.Idle, f.state.value)
        f.ask(out); f.confirm(out); f.reset(); assertEquals(CancelState.Idle, f.state.value)
    }

    @Test fun theStateKnowsWhichVisitItBelongsTo() {
        assertEquals(null, CancelState.Idle.keyOrNull)
        assertEquals(out, CancelState.Asking(out).keyOrNull); assertEquals(out, CancelState.Sending(out).keyOrNull)
        assertEquals(out, CancelState.Done(out, cancelled).keyOrNull); assertEquals(out, CancelState.Failed(out, "x").keyOrNull)
    }
}
