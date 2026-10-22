package com.pont.atm.ui

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper

/** The POS beep, played from generated audio (see [ToneSynth]). Can be muted from the terminal menu. Call from the main thread. */
class Beeper(context: Context) {
    private val prefs = context.getSharedPreferences("pont-ui", Context.MODE_PRIVATE)
    private val handler = Handler(Looper.getMainLooper())
    private val checkIn by lazy { ToneSynth.render(Beeps.checkIn) }
    private val success by lazy { ToneSynth.render(Beeps.success) }
    private val refusal by lazy { ToneSynth.render(Beeps.refusal) }
    private var current: AudioTrack? = null

    var enabled: Boolean
        get() = prefs.getBoolean("sound", true)
        set(v) { prefs.edit().putBoolean("sound", v).apply() }

    fun checkIn() = play(checkIn)
    fun ok() = play(success)
    fun error() = play(refusal)

    private fun play(pcm: ShortArray) {
        if (!enabled) return
        runCatching {
            stopCurrent()
            val track = AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(ToneSynth.SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(pcm.size * 2)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build()
            track.write(pcm, 0, pcm.size)
            track.play()
            current = track
            val ms = pcm.size * 1000L / ToneSynth.SAMPLE_RATE + 150
            handler.postDelayed({ if (current === track) stopCurrent() }, ms)
        }
    }

    private fun stopCurrent() {
        current?.let { runCatching { it.stop() }; it.release() }
        current = null
    }
}
