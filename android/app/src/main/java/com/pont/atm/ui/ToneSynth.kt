package com.pont.atm.ui

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * The sounds of a card terminal, made with the buzzer waveform of a real one:
 * one short beep when the card is read, one longer beep when the payment is approved,
 * and three lower beeps when it is refused.
 */
object Beeps {
    private fun buzz(hz: Int, ms: Int) = ToneSynth.Segment(hz, ms, gain = 0.5f, wave = ToneSynth.Wave.Buzzer)
    private fun gap(ms: Int) = ToneSynth.Segment(0, ms)

    val read = listOf(buzz(2400, 90))
    val success = listOf(buzz(2400, 400))
    val refusal = listOf(buzz(1200, 140), gap(90), buzz(1200, 140), gap(90), buzz(1200, 140))
}

/**
 * Builds the beep as 16-bit mono PCM. Android's ToneGenerator cuts its tones off at a fixed duration and has
 * no fade, which sounds clipped. Here every tone fades in and out over a few milliseconds (no clicks), and a
 * little silence is added before and after, because audio hardware often swallows the first and last moments.
 */
object ToneSynth {
    const val SAMPLE_RATE = 44100
    private const val FADE_MS = 6

    /** A sine is soft. A buzzer is the band-limited square wave a piezo beeper makes: brighter and carries further. */
    enum class Wave { Sine, Buzzer }

    /** [hz] = 0 is a gap of silence. [gain] is the peak level from 0 to 1. */
    data class Segment(val hz: Int, val ms: Int, val gain: Float = 0.6f, val wave: Wave = Wave.Sine)

    /** One period of the wave as a function of phase, scaled so its peak is exactly 1. */
    private fun shape(wave: Wave, hz: Int, rate: Int): (Double) -> Double = when (wave) {
        Wave.Sine -> { phase -> sin(phase) }
        Wave.Buzzer -> {
            val harmonics = (1..(rate / 2 / hz)).filter { it % 2 == 1 }
            val raw = { phase: Double -> harmonics.sumOf { k -> sin(k * phase) / k } }
            val peak = (1..2000).maxOf { raw(PI * it / 2000) }
            ({ phase -> raw(phase) / peak })
        }
    }

    fun render(segments: List<Segment>, leadMs: Int = 40, tailMs: Int = 60, rate: Int = SAMPLE_RATE): ShortArray {
        fun samples(ms: Int) = ms * rate / 1000
        val out = ShortArray(samples(leadMs) + segments.sumOf { samples(it.ms) } + samples(tailMs))
        var at = samples(leadMs)
        for (seg in segments) {
            val n = samples(seg.ms)
            if (seg.hz > 0) {
                val wave = shape(seg.wave, seg.hz, rate)
                val fade = minOf(samples(FADE_MS), n / 2).coerceAtLeast(1)
                for (i in 0 until n) {
                    val env = when {
                        i < fade -> 0.5 * (1 - cos(PI * i / fade))
                        i >= n - fade -> 0.5 * (1 - cos(PI * (n - 1 - i) / fade))
                        else -> 1.0
                    }
                    out[at + i] = (seg.gain * Short.MAX_VALUE * env * wave(2 * PI * seg.hz * i / rate)).toInt().toShort()
                }
            }
            at += n
        }
        return out
    }
}
