package com.pont.card.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CardsModelTest {
    private class Fake(var next: FetchResult, val gate: CompletableDeferred<Unit>? = null) : CardsFetcher {
        var calls = 0
        override suspend fun fetch(uids: List<String>): FetchResult { calls++; gate?.await(); return next }
    }

    private val kv = InMemoryKeyValueStore()
    private val store = UidStore(kv)
    private val cache = SnapshotCache(kv)
    private val anna = PublicCard("04:A2:3B:1C", true, "Anna", "active", 12, null, emptyList())
    private fun scope() = TestScope(UnconfinedTestDispatcher())

    @Test fun startsFromTheSavedCopies() {
        store.add("04:A2:3B:1C"); cache.put("04:A2:3B:1C", anna)
        val m = CardsModel(CardsRepository(store, cache, Fake(FetchResult.Offline)), scope())
        assertEquals(12, m.state.value.items.single().card!!.balance); assertFalse(m.state.value.loading)
    }

    @Test fun refreshShowsTheServersAnswer() {
        store.add("04:A2:3B:1C")
        val m = CardsModel(CardsRepository(store, cache, Fake(FetchResult.Ok(listOf(anna)))), scope())
        m.refresh()
        val s = m.state.value
        assertEquals(ItemState.Fresh, s.items.single().state); assertFalse(s.loading); assertNull(s.notice)
    }

    @Test fun refreshWhileOfflineKeepsTheCardsAndSaysSo() {
        store.add("04:A2:3B:1C"); cache.put("04:A2:3B:1C", anna)
        val m = CardsModel(CardsRepository(store, cache, Fake(FetchResult.Offline)), scope())
        m.refresh()
        assertEquals(Notice.Offline, m.state.value.notice); assertEquals(12, m.state.value.items.single().card!!.balance)
    }

    @Test fun aSecondRefreshWhileOneRunsIsIgnored() {
        store.add("04:A2:3B:1C")
        val gate = CompletableDeferred<Unit>(); val f = Fake(FetchResult.Ok(listOf(anna)), gate)
        val m = CardsModel(CardsRepository(store, cache, f), scope())
        m.refresh(); assertTrue(m.state.value.loading)
        m.refresh(); assertEquals(1, f.calls)
        gate.complete(Unit)
        assertFalse(m.state.value.loading)
        m.refresh(); assertEquals(2, f.calls)
    }

    @Test fun removeDropsTheCardEverywhere() {
        store.add("04:A2:3B:1C"); cache.put("04:A2:3B:1C", anna)
        val m = CardsModel(CardsRepository(store, cache, Fake(FetchResult.Offline)), scope())
        m.remove("04:A2:3B:1C")
        assertTrue(m.state.value.items.isEmpty()); assertTrue(store.list().isEmpty()); assertNull(cache.get("04:A2:3B:1C"))
    }

    @Test fun reloadPicksUpACardAddedElsewhere() {
        val m = CardsModel(CardsRepository(store, cache, Fake(FetchResult.Offline)), scope())
        assertTrue(m.state.value.items.isEmpty())
        store.add("04:A2:3B:1C"); cache.put("04:A2:3B:1C", anna)
        m.reload()
        assertEquals("Anna", m.state.value.items.single().card!!.name)
    }
}
