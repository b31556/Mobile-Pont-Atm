package com.pont.card.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CardsRepositoryTest {
    private class Fake(var next: FetchResult) : CardsFetcher {
        val calls = mutableListOf<List<String>>()
        override suspend fun fetch(uids: List<String>): FetchResult { calls += uids; return next }
    }

    private val kv = InMemoryKeyValueStore()
    private val store = UidStore(kv)
    private val cache = SnapshotCache(kv)
    private fun anna(balance: Int = 12) = PublicCard("04:A2:3B:1C", true, "Anna", "active", balance, null, emptyList())
    private fun bela(balance: Int = 5) = PublicCard("04:BB:CC:DD", true, "Béla", "active", balance, null, emptyList())

    @Test fun refreshWithNoCardsAsksNobody() = runTest {
        val f = Fake(FetchResult.Ok(emptyList()))
        val r = CardsRepository(store, cache, f).refresh()
        assertTrue(r.items.isEmpty()); assertNull(r.notice); assertTrue(f.calls.isEmpty())
    }

    @Test fun refreshAsksForAllSavedCardsInOrderAndKeepsTheAnswers() = runTest {
        store.add("04:BB:CC:DD"); store.add("04:A2:3B:1C")
        val f = Fake(FetchResult.Ok(listOf(anna(), bela())))
        val repo = CardsRepository(store, cache, f)
        val r = repo.refresh()
        assertEquals(listOf(listOf("04:BB:CC:DD", "04:A2:3B:1C")), f.calls)
        assertEquals(listOf("04:BB:CC:DD", "04:A2:3B:1C"), r.items.map { it.uid })
        assertEquals(listOf(5, 12), r.items.map { it.card!!.balance })
        assertTrue(r.items.all { it.state == ItemState.Fresh }); assertNull(r.notice)
        assertEquals(12, cache.get("04:A2:3B:1C")!!.balance)
    }

    @Test fun theServerMaySpellTheUidDifferently() = runTest {
        store.add("04:A2:3B:1C")
        val r = CardsRepository(store, cache, Fake(FetchResult.Ok(listOf(anna().copy(uid = "04a23b1c"))))).refresh()
        assertEquals("04:A2:3B:1C", r.items.single().uid); assertEquals(ItemState.Fresh, r.items.single().state)
    }

    @Test fun anUnregisteredCardIsMarkedAndItsCopyDropped() = runTest {
        store.add("04:A2:3B:1C"); cache.put("04:A2:3B:1C", anna())
        val r = CardsRepository(store, cache, Fake(FetchResult.Ok(listOf(PublicCard("04:A2:3B:1C", found = false))))).refresh()
        assertEquals(ItemState.NotRegistered, r.items.single().state); assertNull(r.items.single().card); assertNull(cache.get("04:A2:3B:1C"))
        assertEquals(listOf("04:A2:3B:1C"), store.list()) // the user decides to remove it
    }

    @Test fun offlineShowsTheSavedCopiesWithANotice() = runTest {
        store.add("04:A2:3B:1C"); store.add("04:BB:CC:DD"); cache.put("04:A2:3B:1C", anna(12))
        val r = CardsRepository(store, cache, Fake(FetchResult.Offline)).refresh()
        assertEquals(Notice.Offline, r.notice)
        assertEquals(ItemState.Saved, r.items[0].state); assertEquals(12, r.items[0].card!!.balance)
        assertEquals(ItemState.Unavailable, r.items[1].state); assertNull(r.items[1].card)
    }

    @Test fun httpErrorsShowTheMessageAndStillTheSavedCopies() = runTest {
        store.add("04:A2:3B:1C"); cache.put("04:A2:3B:1C", anna(12))
        val r429 = CardsRepository(store, cache, Fake(FetchResult.TooManyTries)).refresh()
        assertEquals(Notice.Problem("Too many tries, wait a few minutes"), r429.notice); assertEquals(12, r429.items.single().card!!.balance)
        val r500 = CardsRepository(store, cache, Fake(FetchResult.ServerError(500, "Something broke"))).refresh()
        assertEquals(Notice.Problem("Something broke"), r500.notice)
    }

    @Test fun aCardMissingFromTheAnswerFallsBackToItsSavedCopy() = runTest {
        store.add("04:A2:3B:1C"); store.add("04:BB:CC:DD"); cache.put("04:BB:CC:DD", bela(7))
        val r = CardsRepository(store, cache, Fake(FetchResult.Ok(listOf(anna())))).refresh()
        assertEquals(ItemState.Fresh, r.items[0].state); assertEquals(ItemState.Saved, r.items[1].state); assertEquals(7, r.items[1].card!!.balance)
    }

    @Test fun savedShowsWhatIsOnThePhoneWithoutTheServer() {
        store.add("04:A2:3B:1C"); store.add("04:BB:CC:DD"); cache.put("04:A2:3B:1C", anna())
        val s = CardsRepository(store, cache, Fake(FetchResult.Offline)).saved()
        assertEquals(listOf(ItemState.Saved, ItemState.Unavailable), s.map { it.state })
    }

    // ---- adding by tap ----

    @Test fun aRegisteredCardIsSavedAndItsCopyKept() = runTest {
        val f = Fake(FetchResult.Ok(listOf(anna())))
        val r = CardsRepository(store, cache, f).lookup("04:A2:3B:1C")
        assertEquals(LookupResult.Saved("04:A2:3B:1C", anna(), isNew = true), r)
        assertEquals(listOf(listOf("04:A2:3B:1C")), f.calls)
        assertEquals(listOf("04:A2:3B:1C"), store.list()); assertEquals(12, cache.get("04:A2:3B:1C")!!.balance)
    }

    @Test fun aCardAlreadyOnThePhoneIsNotNewButIsRefreshed() = runTest {
        store.add("04:A2:3B:1C")
        val r = CardsRepository(store, cache, Fake(FetchResult.Ok(listOf(anna(20))))).lookup("04:A2:3B:1C") as LookupResult.Saved
        assertEquals(false, r.isNew); assertEquals(1, store.list().size); assertEquals(20, cache.get("04:A2:3B:1C")!!.balance)
    }

    @Test fun anUnregisteredCardIsNotSaved() = runTest {
        val r = CardsRepository(store, cache, Fake(FetchResult.Ok(listOf(PublicCard("04:A2:3B:1C", found = false))))).lookup("04:A2:3B:1C")
        assertEquals(LookupResult.NotRegistered, r); assertTrue(store.list().isEmpty())
    }

    @Test fun lookupFailuresSayWhy() = runTest {
        assertEquals(LookupResult.Failed("Can't reach the server.", true), CardsRepository(store, cache, Fake(FetchResult.Offline)).lookup("04:A2:3B:1C"))
        assertEquals(LookupResult.Failed("Too many tries, wait a few minutes", false), CardsRepository(store, cache, Fake(FetchResult.TooManyTries)).lookup("04:A2:3B:1C"))
        assertTrue(store.list().isEmpty())
    }

    @Test fun aFullPhoneRefusesBeforeAskingTheServer() = runTest {
        repeat(UidStore.MAX_CARDS) { store.add("04:00:00:%02X".format(it)) }
        val f = Fake(FetchResult.Ok(listOf(anna())))
        assertEquals(LookupResult.Full, CardsRepository(store, cache, f).lookup("04:A2:3B:1C"))
        assertTrue(f.calls.isEmpty())
    }

    @Test fun removeForgetsTheCardAndItsCopy() = runTest {
        store.add("04:A2:3B:1C"); cache.put("04:A2:3B:1C", anna())
        CardsRepository(store, cache, Fake(FetchResult.Offline)).remove("04:A2:3B:1C")
        assertTrue(store.list().isEmpty()); assertNull(cache.get("04:A2:3B:1C"))
    }
}
