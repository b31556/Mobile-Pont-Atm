package com.pont.atm.ui

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/** The sounds the terminal makes. Success rises, a refusal falls; both are short. */
object Beeps {
    val success = listOf(ToneSynth.Segment(1568, 70), ToneSynth.Segment(0, 25), ToneSynth.Segment(2093, 130))
    val refusal = listOf(ToneSynth.Segment(392, 140), ToneSynth.Segment(0, 40), ToneSynth.Segment(262, 260))
}

/**
 * Builds the beep as 16-bit mono PCM. Android's ToneGenerator cuts its tones off at a fixed duration and has
 * no fade, which sounds clipped. Here every tone fades in and out over a few milliseconds (no clicks), and a
 * little silence is added before and after, because audio hardware often swallows the first and last moments.
 */
object ToneSynth {
    const val SAMPLE_RATE = 44100
    private const val FADE_MS = 6

    /** [hz] = 0 is a gap of silence. [gain] is the peak level from 0 to 1. */
    data class Segment(val hz: Int, val ms: Int, val gain: Float = 0.6f)

    fun render(segments: List<Segment>, leadMs: Int = 40, tailMs: Int = 60, rate: Int = SAMPLE_RATE): ShortArray {
        fun samples(ms: Int) = ms * rate / 1000
        val out = ShortArray(samples(leadMs) + segments.sumOf { samples(it.ms) } + samples(tailMs))
        var at = samples(leadMs)
        for (seg in segments) {
            val n = samples(seg.ms)
            if (seg.hz > 0) {
                val fade = minOf(samples(FADE_MS), n / 2).coerceAtLeast(1)
                for (i in 0 until n) {
                    val env = when {
                        i < fade -> 0.5 * (1 - cos(PI * i / fade))
                        i >= n - fade -> 0.5 * (1 - cos(PI * (n - 1 - i) / fade))
                        else -> 1.0
                    }
                    out[at + i] = (seg.gain * Short.MAX_VALUE * env * sin(2 * PI * seg.hz * i / rate)).toInt().toShort()
                }
            }
            at += n
        }
        return out
    }
}
