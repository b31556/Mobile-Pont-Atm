package com.pont.card.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AddCardFlowTest {
    private class Fake(var next: FetchResult, val gate: CompletableDeferred<Unit>? = null) : CardsFetcher {
        val calls = mutableListOf<List<String>>()
        override suspend fun fetch(uids: List<String>): FetchResult { calls += uids; gate?.await(); return next }
    }

    private val kv = InMemoryKeyValueStore()
    private val store = UidStore(kv)
    private val anna = PublicCard("04:A2:3B:1C", true, "Anna Kovács", "active", 12, null, emptyList())
    private val id = byteArrayOf(0x04, 0xA2.toByte(), 0x3B, 0x1C)
    private fun flow(f: CardsFetcher) = AddCardFlow(CardsRepository(store, SnapshotCache(kv), f))

    @Test fun startsWaiting() = assertEquals(AddState.Waiting, flow(Fake(FetchResult.Offline)).state.value)

    @Test fun aRegisteredCardIsAddedAndSaved() = runTest {
        val api = Fake(FetchResult.Ok(listOf(anna))); val f = flow(api)
        f.onTagId(id)
        assertEquals(AddState.Added("04:A2:3B:1C", "Anna Kovács", true), f.state.value)
        assertEquals(listOf(listOf("04:A2:3B:1C")), api.calls)
        assertEquals(listOf("04:A2:3B:1C"), store.list())
    }

    @Test fun anUnregisteredCardIsSaidSoAndNotSaved() = runTest {
        val f = flow(Fake(FetchResult.Ok(listOf(PublicCard("04:A2:3B:1C", found = false)))))
        f.onTagId(id)
        assertEquals(AddState.NotRegistered, f.state.value); assertTrue(store.list().isEmpty())
    }

    @Test fun aFailureIsShownWithItsReason() = runTest {
        val f = flow(Fake(FetchResult.Offline)); f.onTagId(id)
        assertEquals(AddState.Error("Can't reach the server.", true), f.state.value)
        val g = flow(Fake(FetchResult.TooManyTries)); g.onTagId(id)
        assertEquals(AddState.Error("Too many tries, wait a few minutes", false), g.state.value)
    }

    @Test fun aCardThatCantBeUsedNeverReachesTheServer() = runTest {
        val api = Fake(FetchResult.Ok(listOf(anna))); val f = flow(api)
        f.onTagId(ByteArray(8))
        assertEquals(AddState.Unsupported, f.state.value); assertTrue(api.calls.isEmpty())
    }

    @Test fun theNextTapAfterAProblemTriesAgain() = runTest {
        val api = Fake(FetchResult.Offline); val f = flow(api)
        f.onTagId(id)
        api.next = FetchResult.Ok(listOf(anna)); f.onTagId(id)
        assertTrue(f.state.value is AddState.Added); assertEquals(2, api.calls.size)
    }

    @Test fun aTapWhileLookingUpIsIgnored() = runTest {
        val gate = CompletableDeferred<Unit>(); val api = Fake(FetchResult.Ok(listOf(anna)), gate); val f = flow(api)
        val a = launch { f.onTagId(id) }
        testScheduler.runCurrent()
        assertEquals(AddState.Checking("04:A2:3B:1C"), f.state.value)
        val b = launch { f.onTagId(byteArrayOf(4, 1, 2, 3)) }
        testScheduler.runCurrent(); gate.complete(Unit); a.join(); b.join()
        assertEquals(1, api.calls.size)
    }

    @Test fun aTapAfterACardWasAddedIsIgnoredUntilReset() = runTest {
        val api = Fake(FetchResult.Ok(listOf(anna))); val f = flow(api)
        f.onTagId(id); f.onTagId(id)
        assertEquals(1, api.calls.size)
        f.reset(); assertEquals(AddState.Waiting, f.state.value)
    }

    @Test fun aSecondCardCanBeAddedForAParentWithTwoKids() = runTest {
        val api = Fake(FetchResult.Ok(listOf(anna))); val f = flow(api)
        f.onTagId(id); f.reset()
        api.next = FetchResult.Ok(listOf(PublicCard("04:BB:CC:DD", true, "Béla", "active", 3, null, emptyList())))
        f.onTagId(byteArrayOf(4, 0xBB.toByte(), 0xCC.toByte(), 0xDD.toByte()))
        assertEquals(listOf("04:A2:3B:1C", "04:BB:CC:DD"), store.list())
    }

    @Test fun aFullPhoneSaysSo() = runTest {
        repeat(UidStore.MAX_CARDS) { store.add("04:00:00:%02X".format(it)) }
        val f = flow(Fake(FetchResult.Ok(listOf(anna)))); f.onTagId(id)
        assertEquals(AddState.Full, f.state.value)
    }

    @Test fun aCancelledCallerStillGetsTheAnswerInTheState() = runTest {
        val gate = CompletableDeferred<Unit>(); val f = flow(Fake(FetchResult.Ok(listOf(anna)), gate))
        val job = launch { f.onTagId(id) }
        testScheduler.runCurrent(); job.cancel(); gate.complete(Unit); testScheduler.advanceUntilIdle()
        assertTrue(f.state.value is AddState.Added)
    }

    @Test fun anUnexpectedExceptionBecomesAnError() = runTest {
        val f = flow(CardsFetcher { throw IllegalStateException("boom") }); f.onTagId(id)
        assertTrue(f.state.value is AddState.Error)
    }
}
