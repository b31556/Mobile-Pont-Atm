package com.pont.atm.ui

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator

/** The POS beep: two short tones on success, one long low tone on a refusal. Can be muted from the terminal menu. */
class Beeper(context: Context) {
    private val prefs = context.getSharedPreferences("pont-ui", Context.MODE_PRIVATE)
    private val tone: ToneGenerator? = runCatching { ToneGenerator(AudioManager.STREAM_MUSIC, 80) }.getOrNull()

    var enabled: Boolean
        get() = prefs.getBoolean("sound", true)
        set(v) { prefs.edit().putBoolean("sound", v).apply() }

    fun ok() { if (enabled) tone?.startTone(ToneGenerator.TONE_PROP_BEEP2, 250) }
    fun error() { if (enabled) tone?.startTone(ToneGenerator.TONE_SUP_ERROR, 500) }
}
