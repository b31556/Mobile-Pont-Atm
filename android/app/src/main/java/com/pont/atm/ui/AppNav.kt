package com.pont.atm.ui

import android.os.Build
import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.pont.atm.AppGraph
import com.pont.atm.BuildConfig
import com.pont.atm.core.ApiException
import com.pont.atm.core.ChargeOutcome
import com.pont.atm.core.FlowState
import com.pont.atm.core.PresenceOutcome
import com.pont.atm.core.PresenceState
import com.pont.atm.nfc.NfcReader
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** How long the result of a check-in tap stays on screen before the phone goes back to "Tap your card". */
private const val PRESENCE_SHOW_MS = 5_000L

@Composable
fun AppNav(graph: AppGraph, reader: NfcReader) {
    val session = graph.session
    val api = graph.api
    val flow = graph.flow
    val scope = rememberCoroutineScope()

    var screen by remember {
        mutableStateOf<Screen>(
            if (session.terminalToken == null) Screen.Pair else Screen.Charge,
        )
    }
    val flowState by flow.state.collectAsState()
    val pad = remember { NumpadState() }
    var online by remember { mutableStateOf(true) }
    var menu by remember { mutableStateOf(false) }
    var confirmUnpair by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var authError by remember { mutableStateOf<String?>(null) }
    var sound by remember { mutableStateOf(graph.beeper.enabled) }
    var resultReady by remember { mutableStateOf(false) }
    var sendStart by remember { mutableLongStateOf(0L) }
    var nfc by remember { mutableStateOf(reader.status()) }
    // `atm` or `presence`: set by the server per terminal, remembered so a restart opens in the right mode.
    var mode by remember { mutableStateOf(session.mode) }
    val currentMode by rememberUpdatedState(mode)
    val presenceState by graph.presence.state.collectAsState()

    fun noteResult(r: Result<*>) {
        r.onSuccess { online = true }.onFailure { online = (it as? ApiException)?.code != "no_connection" }
        // The server stopped accepting this phone (revoked in admin): back to pairing.
        if (session.terminalToken == null && screen != Screen.Pair) { flow.reset(); authError = null; mode = "atm"; screen = Screen.Pair }
    }

    /** Asks the server which mode this phone is in. A switch waits until nothing is in progress. */
    suspend fun refreshConfig() {
        if (session.terminalToken == null) return
        val r = api.config()
        noteResult(r)
        r.onSuccess { c ->
            session.terminalName = c.name
            val idle = flow.state.value is FlowState.Idle && graph.presence.state.value !is PresenceState.Sending
            if (c.mode != mode && idle) { mode = c.mode; session.mode = c.mode; graph.presence.clear() }
        }
    }

    // A short minimum "processing" time so the progress bar is visible, then the POS beep with the result.
    LaunchedEffect(flowState) {
        when (val s = flowState) {
            is FlowState.Sending -> { sendStart = SystemClock.elapsedRealtime(); resultReady = false }
            is FlowState.Done -> {
                val wait = ProcessingTiming.remaining(SystemClock.elapsedRealtime() - sendStart)
                if (wait > 0) delay(wait)
                resultReady = true
                online = s.outcome !is ChargeOutcome.NoConnection
                if (s.outcome is ChargeOutcome.Success) graph.beeper.ok() else graph.beeper.error()
            }
            else -> resultReady = false
        }
    }

    // Reader mode stays on for as long as the app is in the foreground, not just while waiting for a card.
    // Switching it off the moment a tag is read (while the card is still against the phone) lets Android
    // see the card again and open its own "New tag collected" screen on top of the app. ChargeFlow ignores
    // tags that arrive when it isn't waiting for one.
    val waiting = flowState is FlowState.WaitingForCard
    LifecycleResumeEffect(Unit) {
        nfc = reader.status()
        reader.enable { uid -> scope.launch { if (currentMode == "presence") graph.presence.onTag(uid) else flow.onTag(uid) } }
        scope.launch { refreshConfig() }
        onPauseOrDispose { reader.disable() }
    }

    // Pick up a mode change made in the admin site within about half a minute.
    LaunchedEffect(Unit) { while (true) { delay(30_000); refreshConfig() } }

    // Check-in mode: sound for what the tap did, then back to "Tap your card" after a few seconds.
    LaunchedEffect(presenceState) {
        val st = presenceState
        if (st is PresenceState.Showing) {
            online = st.outcome !is PresenceOutcome.NoConnection
            when (val o = st.outcome) {
                is PresenceOutcome.Done -> if (o.result.action == "out") graph.beeper.ok() else graph.beeper.checkIn()
                else -> graph.beeper.error()
            }
            delay(PRESENCE_SHOW_MS)
            graph.presence.clear()
        }
    }

    LaunchedEffect(screen) {
        when (screen) {
            Screen.Charge -> if (session.terminalToken != null) noteResult(graph.presets.load())
            Screen.History -> noteResult(graph.history.load())
            else -> {}
        }
    }
    LaunchedEffect(graph.history.message) { graph.history.message?.let { toast = it; graph.history.message = null } }
    LaunchedEffect(graph.presets.message) { graph.presets.message?.let { toast = it; graph.presets.message = null } }
    LaunchedEffect(toast) { if (toast != null) { delay(2600); toast = null } }

    val showProcessing = flowState is FlowState.Sending || (flowState is FlowState.Done && !resultReady)
    val presenceMode = mode == "presence" && screen != Screen.Pair
    val dark = if (presenceMode) presenceState !is PresenceState.Showing else (waiting || showProcessing)
    val showTabs = !presenceMode && flowState is FlowState.Idle && screen in tabScreens

    Surface(color = if (dark) PontColors.Ink else PontColors.Bg, contentColor = if (dark) Color.White else PontColors.Ink) {
        Box(Modifier.fillMaxSize().statusBarsPadding()) {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f).fillMaxWidth().then(if (showTabs) Modifier else Modifier.navigationBarsPadding())) {
                    when {
                        presenceMode -> PresenceScreen(
                            presenceState, api, session.terminalName.orEmpty(), onMenu = { menu = true },
                            onDebugTag = { uid -> scope.launch { graph.presence.onTag(uid) } },
                        )
                        waiting -> TapScreen((flowState as FlowState.WaitingForCard).amount, nfc, onDebugTag = { uid -> scope.launch { flow.onTag(uid) } }) { flow.cancel() }
                        showProcessing -> ProcessingScreen(
                            (flowState as? FlowState.Sending)?.uid ?: (flowState as FlowState.Done).uid,
                        )
                        flowState is FlowState.Done -> ResultScreen(
                            done = flowState as FlowState.Done, api = api, terminal = session.terminalName.orEmpty(),
                            onNext = {
                                flow.reset(); pad.clear()
                                noteResult(Result.success(Unit))
                            },
                            onSame = { flow.start((flowState as FlowState.Done).amount) },
                            onRetry = { flow.retry() },
                            onStorno = { id -> api.storno(id).also { noteResult(it) } },
                            onSuggest = { uid -> api.suggestCard(uid).also { noteResult(it) } },
                        )
                        else -> when (screen) {
                            Screen.Pair -> PairScreen(busy, authError) { code ->
                                scope.launch {
                                    busy = true; authError = null
                                    api.pair(code, Build.MODEL ?: "Android", BuildConfig.VERSION_NAME)
                                        .onSuccess { screen = Screen.Charge; refreshConfig() }.onFailure { authError = it.message }
                                    busy = false
                                }
                            }
                            Screen.History -> HistoryScreen(graph.history, api, session.terminalName.orEmpty()) { noteResult(Result.success(Unit)) }
                            Screen.Presets -> PresetsScreen(graph.presets, session.terminalName.orEmpty())
                            else -> ChargeScreen(
                                pad = pad, presets = graph.presets.values, instant = graph.presets.instant,
                                terminal = session.terminalName.orEmpty(), online = online,
                                onPreset = { p -> if (graph.presets.instant) flow.start(p) else pad.set(p) },
                                onCharge = { if (pad.amount > 0) flow.start(pad.amount) },
                                onMenu = { menu = true },
                            )
                        }
                    }
                }
                if (showTabs) TabBar(selected = screen, onSelect = { screen = it })
            }

            if (menu) BottomSheet(onDismiss = { menu = false; confirmUnpair = false }) {
                if (confirmUnpair) {
                    Text("Unpair this phone?", style = PontType.display(22))
                    Text("It stops being the ${session.terminalName.orEmpty()} terminal. An admin has to create a new pairing code to use it again.", color = PontColors.Ink2)
                    SheetButtons("Keep", { confirmUnpair = false }, "Unpair", {
                        menu = false; confirmUnpair = false; api.unpair(); noteResult(Result.success(Unit))
                    })
                } else {
                    Text(session.terminalName.orEmpty(), style = PontType.display(22))
                    Text("Terminal · app ${BuildConfig.VERSION_NAME}", color = PontColors.Ink2)
                    Text(session.baseUrl, color = PontColors.Ink3, fontSize = 12.sp)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text("Beep on result", fontWeight = FontWeight.Bold)
                        PontSwitch(sound, "Beep on result") { sound = it; graph.beeper.enabled = it }
                    }
                    SheetButtons("Close", { menu = false }, "Unpair…", { confirmUnpair = true })
                }
            }
            toast?.let { Toast(it, Modifier.align(Alignment.BottomCenter).padding(bottom = if (showTabs) 84.dp else 24.dp).navigationBarsPadding(), dark = dark) }
        }
    }
}

@Composable
fun TabBar(selected: Screen, onSelect: (Screen) -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(PontColors.Paper).navigationBarsPadding().height(66.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        listOf(Screen.Charge to "Charge", Screen.History to "History", Screen.Presets to "Presets").forEach { (s, label) ->
            Box(Modifier.weight(1f).fillMaxSize().clickable { onSelect(s) }, contentAlignment = Alignment.Center) {
                Text(
                    label, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    color = if (s == selected) PontColors.GreenDark else PontColors.Ink3,
                    modifier = Modifier.padding(4.dp),
                )
            }
        }
    }
}
