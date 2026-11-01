package com.pont.card.ui

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
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
    var adding by rememberSaveable { mutableStateOf(false) }
    var openUid by rememberSaveable { mutableStateOf<String?>(null) }
    var nfc by remember { mutableStateOf(reader.status()) }

    // Ask the server whenever the app comes to the front (that includes opening it).
    LifecycleResumeEffect(Unit) {
        nfc = reader.status()
        graph.model.refresh()
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
        else -> HomeScreen(home, nfc, onRefresh = graph.model::refresh, onOpen = { openUid = it }, onAdd = { adding = true })
    }
}
