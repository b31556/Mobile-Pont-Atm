package com.pont.card.ui

import android.content.Intent
import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pont.card.core.AddState
import com.pont.card.core.UidStore
import com.pont.card.nfc.NfcStatus

/** What the add screen says for a state: a title and a line under it. */
data class AddCopy(val title: String, val message: String)

fun addCopy(state: AddState, nfc: NfcStatus): AddCopy = when {
    nfc == NfcStatus.Unsupported -> AddCopy("No NFC on this phone", "Adding a card needs NFC, and this phone doesn't have it.")
    nfc == NfcStatus.Disabled -> AddCopy("NFC is off", "Turn NFC on in Settings, then hold your card to the back of your phone.")
    else -> when (state) {
        AddState.Waiting -> AddCopy("Hold your card to the back of your phone", "Keep it still for a moment.")
        is AddState.Checking -> AddCopy("Looking up your card…", "")
        is AddState.Added -> AddCopy("Card added", state.name)
        AddState.NotRegistered -> AddCopy("This card isn't registered", "Ask the event staff to add it. Hold another card to try again.")
        AddState.Full -> AddCopy("That's the most cards", "You can keep up to ${UidStore.MAX_CARDS} cards on this phone. Remove one first.")
        AddState.Unsupported -> AddCopy("This card can't be read", "The app can't use this kind of card. Try another one.")
        is AddState.Error -> AddCopy(if (state.offline) "No connection" else "Couldn't add the card", state.message + " Hold the card to the phone to try again.")
    }
}

@Composable
fun AddCardScreen(state: AddState, nfc: NfcStatus, onClose: () -> Unit) {
    val p = palette
    val ctx = LocalContext.current
    val copy = addCopy(state, nfc)
    val problem = nfc == NfcStatus.Ready && state !is AddState.Waiting && state !is AddState.Checking && state !is AddState.Added
    Column(Modifier.fillMaxSize().background(p.bg).statusBarsPadding().padding(horizontal = 28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            if (nfc == NfcStatus.Ready && !problem) {
                if (state is AddState.Checking) CircularProgressIndicator(Modifier.size(96.dp).padding(bottom = 8.dp), color = p.green, strokeWidth = 6.dp)
                else Rings()
                Spacer(Modifier.height(28.dp))
            }
            Text(copy.title, style = Type.display(30), color = if (problem) p.red else p.ink, textAlign = TextAlign.Center)
            if (copy.message.isNotEmpty()) {
                Text(copy.message, color = p.ink2, fontSize = 18.sp, textAlign = TextAlign.Center, lineHeight = 26.sp, modifier = Modifier.padding(top = 12.dp))
            }
            if (nfc == NfcStatus.Disabled) {
                Spacer(Modifier.height(28.dp))
                PrimaryButton("Open NFC settings") { ctx.startActivity(Intent(Settings.ACTION_NFC_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
        }
        SoftButton("Cancel", Modifier.padding(bottom = 20.dp).navigationBarsPadding(), onClose)
    }
}

/** Pulsing rings around a contactless symbol. */
@Composable
private fun Rings() {
    val p = palette
    val t = rememberInfiniteTransition(label = "rings")
    val phases = listOf(0, 800, 1600).map { offset ->
        t.animateFloat(0f, 1f, infiniteRepeatable(tween(2400, easing = LinearEasing), RepeatMode.Restart, StartOffset(offset)), label = "ring$offset")
    }
    Box(Modifier.size(220.dp), contentAlignment = Alignment.Center) {
        phases.forEach { ph ->
            Canvas(Modifier.fillMaxSize()) {
                val progress = ph.value
                drawCircle(p.amber.copy(alpha = (1f - progress) * 0.9f), radius = size.minDimension / 2f * (0.45f + 0.55f * progress), style = Stroke(2.dp.toPx()))
            }
        }
        Box(Modifier.size(96.dp).background(p.amber, CircleShape), contentAlignment = Alignment.Center) {
            Canvas(Modifier.size(48.dp)) {
                listOf(10.dp, 18.dp, 26.dp).forEach { r ->
                    val rp = r.toPx()
                    drawArc(androidx.compose.ui.graphics.Color(0xFF12202B), -45f, 90f, false, Offset(size.width * 0.3f - rp, size.height / 2f - rp), Size(rp * 2, rp * 2), style = Stroke(3.dp.toPx(), cap = StrokeCap.Round))
                }
            }
        }
    }
}
