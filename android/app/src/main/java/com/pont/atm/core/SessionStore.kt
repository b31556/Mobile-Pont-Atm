package com.pont.atm.core

import android.content.Context

interface SessionStore {
    var baseUrl: String
    var terminalToken: String?
    var terminalName: String?

    /** `atm` or `presence`, as last set by the server. Used until the next answer arrives. */
    var mode: String

    /** For a check-in phone: `in`, `out` or `toggle`, and the zone it belongs to. */
    var direction: String
    var zoneName: String?
}

class InMemorySessionStore : SessionStore {
    override var baseUrl = ""
    override var terminalToken: String? = null
    override var terminalName: String? = null
    override var mode = "atm"
    override var direction = "toggle"
    override var zoneName: String? = null
}

class PrefsSessionStore(context: Context, defaultBaseUrl: String) : SessionStore {
    private val prefs = context.getSharedPreferences("pont-session", Context.MODE_PRIVATE)
    private val default = defaultBaseUrl

    private fun str(key: String) = prefs.getString(key, null)
    private fun put(key: String, v: String?) = prefs.edit().apply { if (v == null) remove(key) else putString(key, v) }.apply()

    /** Fixed at build time (BuildConfig.DEFAULT_BASE_URL); an address saved by an older build is ignored. */
    override var baseUrl: String
        get() = default
        set(_) = Unit
    override var terminalToken: String? get() = str("terminalToken"); set(v) = put("terminalToken", v)
    override var terminalName: String? get() = str("terminalName"); set(v) = put("terminalName", v)
    override var mode: String get() = str("mode") ?: "atm"; set(v) = put("mode", v)
    override var direction: String get() = str("direction") ?: "toggle"; set(v) = put("direction", v)
    override var zoneName: String? get() = str("zoneName"); set(v) = put("zoneName", v)
}
