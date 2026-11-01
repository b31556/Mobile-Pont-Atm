package com.pont.card.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.pont.card.AppGraph
import com.pont.card.core.AddState
import com.pont.card.nfc.NfcReader
import kotlinx.coroutines.launch

/** Home, the add-a-card screen, or one card's detail. Which one is kept across turning the phone. */
@Composable
fun AppRoot(graph: AppGraph, reader: NfcReader) {
    val home by graph.model.state.collectAsState()
    val addState by graph.add.state.collectAsState()
    val program by graph.program.state.collectAsState()
    var tab by rememberSaveable { mutableStateOf(0) }   // 0 Card, 1 Program
    var adding by rememberSaveable { mutableStateOf(false) }
    var openUid by rememberSaveable { mutableStateOf<String?>(null) }
    var nfc by remember { mutableStateOf(reader.status()) }

    // Ask the server whenever the app comes to the front (that includes opening it).
    LifecycleResumeEffect(Unit) {
        nfc = reader.status()
        graph.model.refresh()
        graph.program.refresh()
        onPauseOrDispose { }
    }

    // Reader mode is on only while the add screen is showing.
    if (adding) {
        LifecycleResumeEffect(Unit) {
            nfc = reader.status()
            graph.add.reset()
            reader.enable { id -> graph.scope.launch { graph.add.onTagId(id) } }
            onPauseOrDispose { reader.disable() }
        }
    }

    // A card was read and saved: show it.
    LaunchedEffect(addState) {
        val s = addState
        if (s is AddState.Added) {
            graph.model.reload()
            graph.add.reset()
            adding = false
            openUid = s.uid
            graph.model.refresh()
        }
    }

    val item = home.items.firstOrNull { it.uid == openUid }
    // A card removed (or never there) leaves the detail.
    LaunchedEffect(openUid, home.items) { if (openUid != null && !adding && item == null) openUid = null }

    when {
        adding -> {
            BackHandler { adding = false }
            AddCardScreen(addState, nfc) { adding = false }
        }
        openUid != null -> {
            BackHandler { openUid = null }
            DetailScreen(
                item, home.notice, home.loading, onBack = { openUid = null }, onRefresh = graph.model::refresh,
                onRemove = { openUid?.let { graph.model.remove(it) }; openUid = null },
            )
        }
        else -> Column(Modifier.fillMaxSize().background(palette.bg)) {
            Box(Modifier.weight(1f)) {
                if (tab == 0) HomeScreen(home, nfc, onRefresh = graph.model::refresh, onOpen = { openUid = it }, onAdd = { adding = true })
                else ProgramScreen(
                    program, home.items.firstOrNull()?.card, onRefresh = graph.program::refresh,
                    onLike = graph.program::toggleLike, onPlace = graph.program::place, onRemove = graph.program::remove,
                    onSkip = graph.program::skip, onUnskipAll = graph.program::unskipAll,
                )
            }
            BottomBar(tab) { tab = it }
        }
    }
}

/** The two parts of the app: your card, and the program. */
@Composable
private fun BottomBar(selected: Int, onSelect: (Int) -> Unit) {
    val p = palette
    Row(Modifier.fillMaxWidth().background(p.surface).navigationBarsPadding(), horizontalArrangement = Arrangement.SpaceEvenly) {
        listOf("Card", "Program").forEachIndexed { i, label ->
            Box(
                Modifier.weight(1f).heightIn(min = 56.dp).clickable(role = Role.Tab) { onSelect(i) },
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.heightIn(min = 4.dp).padding(bottom = 4.dp).background(if (i == selected) p.amber else p.surface, androidx.compose.foundation.shape.RoundedCornerShape(50)).padding(horizontal = 16.dp, vertical = 2.dp))
                    Text(label, color = if (i == selected) p.ink else p.ink3, fontWeight = if (i == selected) FontWeight.ExtraBold else FontWeight.SemiBold, fontSize = 14.sp)
                }
            }
        }
    }
}
