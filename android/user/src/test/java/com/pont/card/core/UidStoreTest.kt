package com.pont.card.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UidStoreTest {
    private val kv = InMemoryKeyValueStore()
    private val store = UidStore(kv)

    @Test fun startsEmpty() = assertEquals(emptyList<String>(), store.list())

    @Test fun cardsKeepTheOrderTheyWereAddedIn() {
        store.add("04:BB:CC:DD"); store.add("04:A2:3B:1C"); store.add("04:00:00:01")
        assertEquals(listOf("04:BB:CC:DD", "04:A2:3B:1C", "04:00:00:01"), store.list())
    }

    @Test fun theSameCardIsNeverSavedTwiceWhateverTheSpelling() {
        assertEquals(AddResult.Added, store.add("04:A2:3B:1C"))
        assertEquals(AddResult.AlreadySaved, store.add("04a23b1c"))
        assertEquals(AddResult.AlreadySaved, store.add("04-A2-3B-1C"))
        assertEquals(listOf("04:A2:3B:1C"), store.list())
    }

    @Test fun addingAgainDoesNotMoveACard() {
        store.add("04:A2:3B:1C"); store.add("04:BB:CC:DD"); store.add("04:A2:3B:1C")
        assertEquals(listOf("04:A2:3B:1C", "04:BB:CC:DD"), store.list())
    }

    @Test fun savedUidsAreCanonical() {
        store.add("04a23b1c")
        assertEquals(listOf("04:A2:3B:1C"), store.list())
    }

    @Test fun removingTakesOneCardOutAndLeavesTheRest() {
        store.add("04:A2:3B:1C"); store.add("04:BB:CC:DD")
        store.remove("04a23b1c")
        assertEquals(listOf("04:BB:CC:DD"), store.list())
        store.remove("04:BB:CC:DD")
        assertEquals(emptyList<String>(), store.list())
        assertNull(kv.get("uids"))
    }

    @Test fun removingAnUnknownCardChangesNothing() {
        store.add("04:A2:3B:1C"); store.remove("04:EE:EE:EE"); store.remove("junk")
        assertEquals(listOf("04:A2:3B:1C"), store.list())
    }

    @Test fun invalidUidsAreRefused() {
        assertEquals(AddResult.Invalid, store.add("nope"))
        assertEquals(emptyList<String>(), store.list())
    }

    @Test fun thereIsARoomLimit() {
        repeat(UidStore.MAX_CARDS) { assertEquals(AddResult.Added, store.add("04:00:00:%02X".format(it))) }
        assertEquals(AddResult.Full, store.add("04:FF:FF:FF"))
        assertEquals(AddResult.AlreadySaved, store.add("04:00:00:00"))
        assertEquals(UidStore.MAX_CARDS, store.list().size)
    }

    @Test fun cardsSurviveARestart() {
        store.add("04:A2:3B:1C"); store.add("04:BB:CC:DD")
        assertEquals(listOf("04:A2:3B:1C", "04:BB:CC:DD"), UidStore(kv).list())
        assertTrue(UidStore(kv).contains("04bbccdd")); assertFalse(UidStore(kv).contains("04:00:00:00"))
    }
}

class SnapshotCacheTest {
    private val cache = SnapshotCache(InMemoryKeyValueStore())
    private val anna = PublicCard(
        "04:A2:3B:1C", true, "Anna Kovács", "blocked", 12, "data:image/jpeg;base64,AAAA",
        listOf(HistoryEntry("2026-11-01T14:20:00.000Z", "presence", 4, "Gym", "34 min", true)),
    )

    @Test fun aSavedCardComesBackExactly() {
        cache.put("04:A2:3B:1C", anna)
        assertEquals(anna, cache.get("04:A2:3B:1C"))
    }

    @Test fun unknownCardsAndUnregisteredAnswersAreNotKept() {
        assertNull(cache.get("04:A2:3B:1C"))
        cache.put("04:A2:3B:1C", PublicCard("04:A2:3B:1C", found = false))
        assertNull(cache.get("04:A2:3B:1C"))
    }

    @Test fun removingForgetsIt() {
        cache.put("04:A2:3B:1C", anna); cache.remove("04:A2:3B:1C")
        assertNull(cache.get("04:A2:3B:1C"))
    }

    @Test fun aDamagedCopyIsIgnored() {
        val kv = InMemoryKeyValueStore(); kv.put("snapshot:04:A2:3B:1C", "{not json")
        assertNull(SnapshotCache(kv).get("04:A2:3B:1C"))
    }
}
