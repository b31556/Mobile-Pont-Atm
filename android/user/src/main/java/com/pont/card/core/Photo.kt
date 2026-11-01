package com.pont.card.core

import java.util.Base64

/**
 * The image bytes inside a `data:image/jpeg;base64,...` string (a bare base64 string works too),
 * or null if there is no photo or it isn't valid base64.
 */
fun decodePhotoBytes(photo: String?): ByteArray? {
    if (photo.isNullOrBlank()) return null
    val payload = if (photo.startsWith("data:")) photo.substringAfter(',', "") else photo
    if (payload.isEmpty()) return null
    return try { Base64.getMimeDecoder().decode(payload) } catch (e: IllegalArgumentException) { null }
        ?.takeIf { it.isNotEmpty() }
}
