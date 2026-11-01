package com.pont.card.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pont.card.core.decodePhotoBytes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Decoded holder photos, kept in memory so scrolling and going back and forth never decodes twice. */
object PhotoCache {
    private val cache = LruCache<String, ImageBitmap>(30)
    private const val MAX_SIDE = 640

    private fun key(photo: String) = "${photo.length}:${photo.hashCode()}"

    /** Decodes off the main thread. Null when there is no photo or it can't be decoded. */
    suspend fun load(photo: String?): ImageBitmap? {
        if (photo.isNullOrBlank()) return null
        val k = key(photo)
        cache.get(k)?.let { return it }
        val bmp = withContext(Dispatchers.Default) {
            val bytes = decodePhotoBytes(photo) ?: return@withContext null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= MAX_SIDE && bounds.outHeight / (sample * 2) >= MAX_SIDE) sample *= 2
            val opts = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap()
        } ?: return null
        cache.put(k, bmp)
        return bmp
    }
}

/** The holder's round photo, or a coloured circle with their initial when there is none. */
@Composable
fun Avatar(photo: String?, name: String, size: Dp, modifier: Modifier = Modifier) {
    val bmp by produceState<ImageBitmap?>(null, photo) { value = PhotoCache.load(photo) }
    val base = modifier.size(size).clip(CircleShape)
    val image = bmp
    if (image != null) {
        Image(image, contentDescription = name, contentScale = ContentScale.Crop, modifier = base)
    } else {
        val hue = ((name.hashCode().toLong() and 0xFFFF) % 360).toFloat()
        val dark = palette.dark
        Box(
            base.background(Color.hsv(hue, if (dark) 0.45f else 0.30f, if (dark) 0.55f else 0.93f)).semantics { contentDescription = name },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                initialOf(name), fontSize = (size.value * 0.42f).sp, fontWeight = FontWeight.ExtraBold,
                color = if (dark) Color.White else Color(0xFF12202B),
            )
        }
    }
}

/** The first letter of a name, uppercase; "?" for an empty one. */
fun initialOf(name: String): String = name.trim().firstOrNull { it.isLetterOrDigit() }?.uppercase() ?: "?"

@Composable
fun PrimaryButton(text: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val p = palette
    Box(
        modifier.fillMaxWidth().heightIn(min = 60.dp).clip(RoundedCornerShape(20.dp)).background(p.green)
            .clickable(role = Role.Button, onClick = onClick).padding(horizontal = 20.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, color = p.onGreen, style = Type.display(19, FontWeight.Bold), textAlign = TextAlign.Center) }
}

@Composable
fun SoftButton(text: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val p = palette
    Box(
        modifier.fillMaxWidth().heightIn(min = 52.dp).clip(RoundedCornerShape(18.dp)).background(p.surface)
            .clickable(role = Role.Button, onClick = onClick).padding(horizontal = 20.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, color = p.ink, fontWeight = FontWeight.Bold, fontSize = 16.sp, textAlign = TextAlign.Center) }
}

enum class Tone { Good, Bad, Warn, Quiet }

/** A rounded note: "Blocked", "Offline, showing saved data", a server message. */
@Composable
fun Banner(text: String, tone: Tone, modifier: Modifier = Modifier, big: Boolean = false) {
    val p = palette
    val (bg, fg) = when (tone) {
        Tone.Good -> p.greenSoft to p.green
        Tone.Bad -> p.redSoft to p.red
        Tone.Warn -> p.amberSoft to (if (p.dark) p.amber else Color(0xFF8A5A00))
        Tone.Quiet -> p.surface to p.ink2
    }
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(if (big) 20.dp else 14.dp)).background(bg)
            .padding(horizontal = 16.dp, vertical = if (big) 16.dp else 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, color = fg, fontWeight = FontWeight.Bold, fontSize = if (big) 18.sp else 14.sp)
    }
}

/** A big points number with its small "points" label. */
@Composable
fun Points(balance: Int, numberSize: Int, modifier: Modifier = Modifier, horizontal: Alignment.Horizontal = Alignment.End) {
    val p = palette
    Column(modifier, horizontalAlignment = horizontal) {
        Text("$balance", style = Type.display(numberSize), color = p.ink, maxLines = 1)
        Text(if (balance == 1) "point" else "points", color = p.ink3, fontSize = if (numberSize >= 56) 18.sp else 13.sp, fontWeight = FontWeight.SemiBold)
    }
}
