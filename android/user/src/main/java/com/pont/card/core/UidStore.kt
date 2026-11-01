package com.pont.card.core

enum class AddResult { Added, AlreadySaved, Full, Invalid }

/**
 * The cards saved on this phone: canonical UIDs in the order they were added, no duplicates.
 * One request to the server carries at most [MAX_CARDS] UIDs, so that is also how many can be saved.
 */
class UidStore(private val kv: KeyValueStore) {
    fun list(): List<String> =
        kv.get(KEY)?.split('\n')?.filter { it.isNotBlank() }?.distinct().orEmpty()

    fun contains(uid: String): Boolean = normalizeUid(uid)?.let { it in list() } ?: false

    fun add(uid: String): AddResult {
        val canonical = normalizeUid(uid) ?: return AddResult.Invalid
        val now = list()
        if (canonical in now) return AddResult.AlreadySaved
        if (now.size >= MAX_CARDS) return AddResult.Full
        save(now + canonical)
        return AddResult.Added
    }

    fun remove(uid: String) {
        val canonical = normalizeUid(uid) ?: return
        save(list() - canonical)
    }

    private fun save(uids: List<String>) {
        if (uids.isEmpty()) kv.remove(KEY) else kv.put(KEY, uids.joinToString("\n"))
    }

    companion object {
        const val MAX_CARDS = 10
        private const val KEY = "uids"
    }
}

/** The last good answer for each card, kept for when the server can't be reached. */
class SnapshotCache(private val kv: KeyValueStore) {
    fun get(uid: String): PublicCard? =
        kv.get(key(uid))?.let { runCatching { PontJson.decodeFromString(PublicCard.serializer(), it) }.getOrNull() }?.takeIf { it.found }

    fun put(uid: String, card: PublicCard) {
        if (!card.found) return
        kv.put(key(uid), PontJson.encodeToString(PublicCard.serializer(), card.copy(uid = uid)))
    }

    fun remove(uid: String) = kv.remove(key(uid))

    private fun key(uid: String) = "snapshot:$uid"
}
