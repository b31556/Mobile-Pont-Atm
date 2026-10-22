package com.pont.atm

import android.content.Context
import com.pont.atm.core.ChargeFlow
import com.pont.atm.core.PontApi
import com.pont.atm.core.PrefsSessionStore
import com.pont.atm.core.SessionStore
import com.pont.atm.ui.Beeper
import com.pont.atm.ui.HistoryViewModel
import com.pont.atm.ui.PresetsViewModel
import java.util.UUID

/** The app's long-lived objects. Lives in [PontApp] so a configuration change mid-charge doesn't lose the flow. */
class AppGraph(context: Context) {
    val session: SessionStore = PrefsSessionStore(context, BuildConfig.DEFAULT_BASE_URL)
    val api = PontApi(session)
    val flow = ChargeFlow({ uid, amount, key -> api.charge(uid, amount, key) }) { UUID.randomUUID().toString() }
    val beeper = Beeper(context)
    val history = HistoryViewModel(api)
    val presets = PresetsViewModel(api)
}
