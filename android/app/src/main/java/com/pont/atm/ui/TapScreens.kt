package com.pont.atm.ui

import android.content.Intent
import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pont.atm.nfc.NfcStatus
import kotlinx.coroutines.delay

private val Muted = Color(0xFF9FB1BD)

@Composable
fun TapScreen(amount: Int, nfc: NfcStatus, onCancel: () -> Unit) {
    val ctx = LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Row2(amount)
            when (nfc) {
                NfcStatus.Ready -> {
                    Text("Hold the card against the back of the phone", color = Muted, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
                    Rings(Modifier.padding(vertical = 34.dp))
                }
                NfcStatus.Disabled -> {
                    Text("NFC is off. Turn it on in Settings to read cards.", color = Muted, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp, bottom = 24.dp))
                    GoButton("Open NFC settings") { ctx.startActivity(Intent(Settings.ACTION_NFC_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                }
                NfcStatus.Unsupported -> Text("This phone has no NFC reader, so it can't be used as a terminal.", color = Muted, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
            }
        }
        GhostButton("Cancel", Color.White, Modifier.padding(bottom = 16.dp), onCancel)
    }
}

@Composable
private fun Row2(amount: Int) {
    androidx.compose.foundation.layout.Row(verticalAlignment = Alignment.Bottom) {
        Text("$amount", style = PontType.display(44), color = Color.White)
        Text(if (amount == 1) "point" else "points", color = Muted, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 6.dp, bottom = 8.dp))
    }
}

@Composable
private fun Rings(modifier: Modifier = Modifier) {
    val t = rememberInfiniteTransition(label = "rings")
    val phases = listOf(0, 800, 1600).map { offset ->
        t.animateFloat(0f, 1f, infiniteRepeatable(tween(2400, easing = LinearEasing), RepeatMode.Restart, StartOffset(offset)), label = "ring$offset")
    }
    Box(modifier.size(220.dp), contentAlignment = Alignment.Center) {
        phases.forEach { p ->
            Canvas(Modifier.fillMaxSize()) {
                val progress = p.value
                drawCircle(PontColors.Amber.copy(alpha = (1f - progress) * 0.9f), radius = size.minDimension / 2f * (0.45f + 0.55f * progress), style = Stroke(2.dp.toPx()))
            }
        }
        Box(Modifier.size(96.dp).background(PontColors.Amber, CircleShape), contentAlignment = Alignment.Center) {
            Canvas(Modifier.size(48.dp)) {
                listOf(10.dp, 18.dp, 26.dp).forEach { r ->
                    val rp = r.toPx()
                    drawArc(PontColors.Ink, -45f, 90f, false, Offset(size.width * 0.3f - rp, size.height / 2f - rp), Size(rp * 2, rp * 2), style = Stroke(3.dp.toPx(), cap = StrokeCap.Round))
                }
            }
        }
    }
}

@Composable
fun ProcessingScreen(uid: String) {
    var stage by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) { delay(450); stage = 1; delay(500); stage = 2 }
    val progress by animateFloatAsState(listOf(0.38f, 0.82f, 1f)[stage], tween(450), label = "progress")
    val steps = listOf("Reading card…", "Sending to server…", "Confirming…")
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        val shape = RoundedCornerShape(16.dp)
        Column(
            Modifier.size(width = 260.dp, height = 164.dp).clip(shape).background(Brush.linearGradient(listOf(Color(0xFF27414F), Color(0xFF1B2E3A)))).padding(16.dp),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("MIFARE Classic 1K", color = Muted, fontWeight = FontWeight.Bold, fontSize = 13.sp)
            Box(Modifier.size(width = 36.dp, height = 28.dp).background(Brush.linearGradient(listOf(Color(0xFFE3C26B), Color(0xFFB88E2B))), RoundedCornerShape(6.dp)))
            Text(if (stage >= 1) uid.replace(':', ' ') else " ", color = Color.White, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
        }
        Box(Modifier.padding(top = 30.dp).size(width = 260.dp, height = 10.dp).clip(RoundedCornerShape(6.dp)).background(Color(0x24FFFFFF))) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(progress).background(PontColors.GreenLight, RoundedCornerShape(6.dp)))
        }
        Text(steps[stage], color = Color.White, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp).height(22.dp))
    }
}

