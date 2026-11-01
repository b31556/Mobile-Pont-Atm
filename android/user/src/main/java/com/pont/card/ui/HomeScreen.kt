package com.pont.card.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pont.card.core.CardItem
import com.pont.card.core.HomeState
import com.pont.card.core.ItemState
import com.pont.card.core.Notice
import com.pont.card.nfc.NfcStatus

/** Words for the notice above the cards. */
fun noticeText(n: Notice): String = when (n) {
    Notice.Offline -> "Offline, showing saved data"
    is Notice.Problem -> n.message
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(state: HomeState, nfc: NfcStatus, onRefresh: () -> Unit, onOpen: (String) -> Unit, onAdd: () -> Unit) {
    val p = palette
    Column(Modifier.fillMaxSize().background(p.bg).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp, top = 20.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Pont Card", color = p.ink3, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Text("Your cards", style = Type.display(34), color = p.ink)
            }
            if (state.items.isNotEmpty()) {
                Box(Modifier.heightIn(min = 48.dp).clip(RoundedCornerShape(16.dp)).clickable(onClick = onRefresh).padding(horizontal = 16.dp, vertical = 12.dp), contentAlignment = Alignment.Center) {
                    Text(if (state.loading) "Refreshing…" else "Refresh", color = p.green, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                }
            }
        }
        state.notice?.let {
            Banner(noticeText(it), if (it is Notice.Offline) Tone.Warn else Tone.Bad, Modifier.padding(horizontal = 20.dp).padding(bottom = 8.dp))
        }
        if (state.items.isEmpty()) {
            EmptyHome(nfc, onAdd, Modifier.weight(1f))
        } else {
            PullToRefreshBox(isRefreshing = state.loading, onRefresh = onRefresh, modifier = Modifier.weight(1f)) {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(state.items, key = { it.uid }) { item -> CardTile(item) { onOpen(item.uid) } }
                }
            }
            if (nfc != NfcStatus.Unsupported) {
                PrimaryButton("Add a card", Modifier.padding(horizontal = 20.dp, vertical = 12.dp).navigationBarsPadding(), onAdd)
            } else {
                Text("Adding a card needs NFC, and this phone doesn't have it.", color = p.ink3, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(16.dp).navigationBarsPadding())
            }
        }
    }
}

@Composable
private fun EmptyHome(nfc: NfcStatus, onAdd: () -> Unit, modifier: Modifier) {
    val p = palette
    Column(modifier.fillMaxWidth().padding(horizontal = 28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Text("No cards yet", style = Type.display(28), color = p.ink, textAlign = TextAlign.Center)
            Spacer(Modifier.height(12.dp))
            Text(
                if (nfc == NfcStatus.Unsupported) "Adding a card needs NFC, and this phone doesn't have it."
                else "Hold your card to the back of your phone to add it",
                color = p.ink2, fontSize = 18.sp, textAlign = TextAlign.Center, lineHeight = 26.sp,
            )
        }
        if (nfc != NfcStatus.Unsupported) PrimaryButton("Add a card", Modifier.padding(bottom = 24.dp).navigationBarsPadding(), onAdd)
    }
}

@Composable
private fun CardTile(item: CardItem, onClick: () -> Unit) {
    val p = palette
    val card = item.card
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(26.dp)).background(p.surface).clickable(onClick = onClick).padding(16.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Avatar(card?.photo, card?.name.orEmpty().ifEmpty { "?" }, 64.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(card?.name?.ifBlank { null } ?: "Card ${item.uid.takeLast(5)}", color = p.ink, fontWeight = FontWeight.Bold, fontSize = 20.sp, maxLines = 2)
            when {
                item.state == ItemState.NotRegistered -> Banner("No longer registered", Tone.Bad)
                item.state == ItemState.Unavailable -> Text("Can't load yet", color = p.ink3, fontSize = 14.sp)
                card?.blocked == true -> Banner("Blocked", Tone.Bad)
            }
        }
        if (card != null) Points(card.balance, 38)
    }
}
