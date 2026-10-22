package com.pont.atm.ui

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pont.atm.core.PontApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun GoButton(text: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        modifier.fillMaxWidth().height(58.dp).clip(RoundedCornerShape(16.dp))
            .background(if (enabled) PontColors.Green else Color(0xFFB9C4CB))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(text, color = Color.White, style = PontType.display(19, FontWeight.Bold)) }
}

@Composable
fun GhostButton(text: String, color: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(14.dp)
    Box(
        modifier.fillMaxWidth().height(50.dp).clip(shape).border(BorderStroke(1.5.dp, color), shape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(text, color = color, fontWeight = FontWeight.Bold, fontSize = 16.sp) }
}

@Composable
fun PontSwitch(checked: Boolean, label: String, onChange: (Boolean) -> Unit) {
    Switch(
        checked = checked, onCheckedChange = onChange,
        colors = SwitchDefaults.colors(checkedTrackColor = PontColors.Green, checkedThumbColor = Color.White, uncheckedTrackColor = Color(0xFFC3CDD3), uncheckedThumbColor = Color.White, uncheckedBorderColor = Color.Transparent),
        modifier = Modifier.semanticsLabel(label),
    )
}

private fun Modifier.semanticsLabel(label: String): Modifier = semantics { contentDescription = label }

/** Dimmed overlay with a sheet at the bottom; tapping outside the sheet calls [onDismiss]. */
@Composable
fun BottomSheet(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(Color(0x8010141C)).clickable(onClick = onDismiss), contentAlignment = Alignment.BottomCenter) {
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 26.dp, topEnd = 26.dp)).background(PontColors.Paper)
                .clickable(enabled = false) {}.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) { content() }
    }
}

@Composable
fun SheetButtons(left: String, onLeft: () -> Unit, right: String?, onRight: () -> Unit = {}, danger: Boolean = true) {
    androidx.compose.foundation.layout.Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
        SheetButton(left, Color(0xFFE6EBEE), PontColors.Ink, Modifier.weight(1f), onLeft)
        if (right != null) SheetButton(right, if (danger) PontColors.Red else PontColors.Green, Color.White, Modifier.weight(1f), onRight)
    }
}

@Composable
private fun SheetButton(text: String, bg: Color, fg: Color, modifier: Modifier, onClick: () -> Unit) {
    Box(modifier.height(50.dp).clip(RoundedCornerShape(14.dp)).background(bg).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Text(text, color = fg, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun Toast(message: String, modifier: Modifier = Modifier, dark: Boolean = false) {
    Box(
        modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp))
            .background(if (dark) Color.White else PontColors.Ink).padding(horizontal = 16.dp, vertical = 12.dp),
    ) { Text(message, color = if (dark) PontColors.Ink else Color.White, fontWeight = FontWeight.SemiBold, fontSize = 14.sp) }
}

/** Holder photos need the operator's token, so they are fetched through the API and cached in memory. */
object PhotoCache {
    private val cache = LruCache<String, ImageBitmap>(40)

    suspend fun load(api: PontApi, path: String): ImageBitmap? {
        cache.get(path)?.let { return it }
        val bytes = api.photoBytes(path) ?: return null
        val bmp = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() } ?: return null
        cache.put(path, bmp)
        return bmp
    }
}

/** Holder photo; falls back to a coloured initial when there is no decodable photo (e.g. the server's SVG placeholder). */
@Composable
fun Avatar(api: PontApi, path: String, name: String, size: Dp, ring: Color? = null) {
    val bmp by produceState<ImageBitmap?>(null, path) { value = if (path.isBlank()) null else PhotoCache.load(api, path) }
    val shape = CircleShape
    val base = Modifier.size(size).clip(shape).let { if (ring != null) it.border(4.dp, ring, shape) else it }
    val image = bmp
    if (image != null) {
        Image(image, contentDescription = name, contentScale = ContentScale.Crop, modifier = base)
    } else {
        val hue = (name.hashCode().toLong() and 0xFFFF) % 360
        Box(base.background(Color.hsv(hue.toFloat(), 0.35f, 0.9f)), contentAlignment = Alignment.Center) {
            Text(name.trim().take(1).uppercase(), fontSize = (size.value * 0.42f).sp, fontWeight = FontWeight.ExtraBold, color = PontColors.Ink)
        }
    }
}
