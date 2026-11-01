package com.pont.card.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** One row of a card's history. `kind` is atm, fixed, presence, storno or adjust; `amount` is signed. */
@Serializable data class HistoryEntry(
    val at: String,
    val kind: String,
    val amount: Int = 0,
    val place: String = "",
    val note: String? = null,
    val stornoed: Boolean = false,
)

/** One answer of POST /public/cards. A card that is not registered only has [uid] and `found = false`. */
@Serializable data class PublicCard(
    val uid: String,
    val found: Boolean = false,
    val name: String = "",
    val status: String = "active",
    val balance: Int = 0,
    /** `data:image/jpeg;base64,...`, or null when the card has no photo. */
    val photo: String? = null,
    val history: List<HistoryEntry> = emptyList(),
) {
    val blocked: Boolean get() = status == "blocked"
}

@Serializable data class CardsRequest(val uids: List<String>)

@Serializable data class CardsResponse(val cards: List<PublicCard> = emptyList())

/** Tolerant on input (unknown fields, nulls where a default exists), complete on output (so a saved copy round-trips). */
val PontJson = Json { ignoreUnknownKeys = true; coerceInputValues = true; encodeDefaults = true }
