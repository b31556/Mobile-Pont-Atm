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
import com.pont.atm.nfc.NfcReader
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val MIN_PROCESSING_MS = 1200L

@Composable
fun AppNav(graph: AppGraph, reader: NfcReader) {
    val session = graph.session
    val api = graph.api
    val flow = graph.flow
    val scope = rememberCoroutineScope()

    var screen by remember {
        mutableStateOf<Screen>(
            when {
                session.terminalToken == null -> Screen.Pair
                session.operatorToken == null -> Screen.Login
                else -> Screen.Charge
            },
        )
    }
    val flowState by flow.state.collectAsState()
    val pad = remember { NumpadState() }
    var online by remember { mutableStateOf(true) }
    var menu by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var authError by remember { mutableStateOf<String?>(null) }
    var sound by remember { mutableStateOf(graph.beeper.enabled) }
    var resultReady by remember { mutableStateOf(false) }
    var sendStart by remember { mutableLongStateOf(0L) }
    var nfc by remember { mutableStateOf(reader.status()) }

    fun noteResult(r: Result<*>) {
        r.onSuccess { online = true }.onFailure { online = (it as? ApiException)?.code != "no_connection" }
        if (session.operatorToken == null && screen != Screen.Pair && screen != Screen.Login) { flow.reset(); screen = Screen.Login }
    }

    // Minimum "processing" time so the progress bar is readable, then the POS beep with the result.
    LaunchedEffect(flowState) {
        when (val s = flowState) {
            is FlowState.Sending -> { sendStart = SystemClock.elapsedRealtime(); resultReady = false }
            is FlowState.Done -> {
                val wait = MIN_PROCESSING_MS - (SystemClock.elapsedRealtime() - sendStart)
                if (wait > 0) delay(wait)
                resultReady = true
                online = s.outcome !is ChargeOutcome.NoConnection
                if (s.outcome is ChargeOutcome.Success) graph.beeper.ok() else graph.beeper.error()
            }
            else -> resultReady = false
        }
    }

    // The NFC reader is only on while the app waits for a card and is in the foreground.
    val waiting = flowState is FlowState.WaitingForCard
    LifecycleResumeEffect(waiting) {
        nfc = reader.status()
        if (waiting) reader.enable { uid -> scope.launch { flow.onTag(uid) } }
        onPauseOrDispose { reader.disable() }
    }

    LaunchedEffect(screen) {
        when (screen) {
            Screen.Charge -> if (session.operatorToken != null) noteResult(graph.presets.load())
            Screen.History -> noteResult(graph.history.load())
            else -> {}
        }
    }
    LaunchedEffect(graph.history.message) { graph.history.message?.let { toast = it; graph.history.message = null } }
    LaunchedEffect(graph.presets.message) { graph.presets.message?.let { toast = it; graph.presets.message = null } }
    LaunchedEffect(toast) { if (toast != null) { delay(2600); toast = null } }

    val showProcessing = flowState is FlowState.Sending || (flowState is FlowState.Done && !resultReady)
    val dark = waiting || showProcessing
    val showTabs = flowState is FlowState.Idle && screen in tabScreens

    Surface(color = if (dark) PontColors.Ink else PontColors.Bg, contentColor = if (dark) Color.White else PontColors.Ink) {
        Box(Modifier.fillMaxSize().statusBarsPadding()) {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f).fillMaxWidth().then(if (showTabs) Modifier else Modifier.navigationBarsPadding())) {
                    when {
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
                            onRetry = { flow.retry() },
                            onStorno = { id -> api.storno(id).also { noteResult(it) } },
                        )
                        else -> when (screen) {
                            Screen.Pair -> PairScreen(session.baseUrl, busy, authError) { server, code ->
                                scope.launch {
                                    busy = true; authError = null
                                    val url = server.trim().trimEnd('/').let { if (it.startsWith("http")) it else (if (BuildConfig.DEBUG) "http://" else "https://") + it }
                                    session.baseUrl = url
                                    api.pair(code, Build.MODEL ?: "Android", BuildConfig.VERSION_NAME)
                                        .onSuccess { screen = Screen.Login }.onFailure { authError = it.message }
                                    busy = false
                                }
                            }
                            Screen.Login -> LoginScreen(session.terminalName.orEmpty(), busy, authError,
                                onLogin = { email, password ->
                                    scope.launch {
                                        busy = true; authError = null
                                        api.login(email, password).onSuccess { screen = Screen.Charge }.onFailure { authError = it.message }
                                        busy = false
                                    }
                                },
                                onRepair = { session.terminalToken = null; api.signOut(); authError = null; screen = Screen.Pair },
                            )
                            Screen.History -> HistoryScreen(graph.history, api, session.terminalName.orEmpty()) { noteResult(Result.success(Unit)) }
                            Screen.Presets -> PresetsScreen(graph.presets, session.terminalName.orEmpty())
                            else -> ChargeScreen(
                                pad = pad, presets = graph.presets.values, instant = graph.presets.instant,
                                terminal = session.terminalName.orEmpty(), operator = session.operatorName.orEmpty(), online = online,
                                onPreset = { p -> if (graph.presets.instant) flow.start(p) else pad.set(p) },
                                onCharge = { if (pad.amount > 0) flow.start(pad.amount) },
                                onMenu = { menu = true },
                            )
                        }
                    }
                }
                if (showTabs) TabBar(selected = screen, onSelect = { screen = it })
            }

            if (menu) BottomSheet(onDismiss = { menu = false }) {
                Text(session.operatorName.orEmpty(), style = PontType.display(22))
                Text("Operator · Terminal ${session.terminalName.orEmpty()} · app ${BuildConfig.VERSION_NAME}", color = PontColors.Ink2)
                Text(session.baseUrl, color = PontColors.Ink3, fontSize = 12.sp)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("Beep on result", fontWeight = FontWeight.Bold)
                    PontSwitch(sound, "Beep on result") { sound = it; graph.beeper.enabled = it }
                }
                SheetButtons("Close", { menu = false }, "Sign out", {
                    menu = false; api.signOut(); flow.reset(); pad.clear(); authError = null; screen = Screen.Login
                })
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
