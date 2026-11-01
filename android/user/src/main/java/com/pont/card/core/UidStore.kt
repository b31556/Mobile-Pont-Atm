package com.pont.card.core

enum class AddResult { Added, AlreadySaved, Full, Invalid }

/**
 * The card saved on this phone: a canonical UID. A phone keeps one card, its owner's own ([MAX_CARDS]); to use another, remove this one first.
 * A phone that saved several under an earlier version keeps showing only the first.
 */
class UidStore(private val kv: KeyValueStore) {
    fun list(): List<String> =
        kv.get(KEY)?.split('\n')?.filter { it.isNotBlank() }?.distinct()?.take(MAX_CARDS).orEmpty()

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
        const val MAX_CARDS = 1
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
