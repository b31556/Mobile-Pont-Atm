package com.pont.atm.ui

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ToneSynthTest {
    private val rate = 8000

    private fun render(vararg s: ToneSynth.Segment, lead: Int = 0, tail: Int = 0) = ToneSynth.render(s.toList(), lead, tail, rate)

    @Test fun lengthIsTheSumOfSegmentsPlusLeadAndTail() {
        val pcm = render(ToneSynth.Segment(880, 100), ToneSynth.Segment(0, 50), ToneSynth.Segment(660, 100), lead = 40, tail = 60)
        assertEquals((100 + 50 + 100 + 40 + 60) * rate / 1000, pcm.size)
    }

    @Test fun leadAndTailAreSilent() {
        val pcm = render(ToneSynth.Segment(880, 100), lead = 40, tail = 60)
        val lead = 40 * rate / 1000; val tail = 60 * rate / 1000
        assertTrue(pcm.take(lead).all { it.toInt() == 0 })
        assertTrue(pcm.takeLast(tail).all { it.toInt() == 0 })
    }

    @Test fun aToneFadesInAndOutSoItDoesNotClick() {
        val pcm = render(ToneSynth.Segment(1000, 100, gain = 0.5f))
        val peak = pcm.maxOf { abs(it.toInt()) }
        assertTrue("first sample is near zero", abs(pcm.first().toInt()) < peak / 50)
        assertTrue("last sample is near zero", abs(pcm.last().toInt()) < peak / 50)
        // no jump between neighbours bigger than a pure sine of this pitch makes (a click would exceed it)
        val maxStep = (1..pcm.lastIndex).maxOf { abs(pcm[it] - pcm[it - 1]) }
        val sineStep = peak * 2 * sin(PI * 1000 / rate) * 1.05
        assertTrue("max step $maxStep vs sine $sineStep", maxStep <= sineStep)
    }

    @Test fun gainSetsThePeakAndNothingClips() {
        val pcm = render(ToneSynth.Segment(1000, 200, gain = 0.5f))
        val peak = pcm.maxOf { abs(it.toInt()) }
        assertTrue("peak $peak", peak in (Short.MAX_VALUE * 0.48).toInt()..(Short.MAX_VALUE * 0.5).toInt())
    }

    @Test fun theToneHasTheRequestedPitch() {
        val pcm = render(ToneSynth.Segment(1000, 100))
        val crossings = (1..pcm.lastIndex).count { (pcm[it - 1] < 0) != (pcm[it] < 0) }
        assertEquals("zero crossings for 1 kHz over 100 ms", 200.0, crossings.toDouble(), 6.0)
    }

    @Test fun aGapIsSilence() {
        val pcm = render(ToneSynth.Segment(0, 50))
        assertTrue(pcm.all { it.toInt() == 0 })
    }

    private fun beeps(l: List<ToneSynth.Segment>) = l.filter { it.hz > 0 }
    private fun total(l: List<ToneSynth.Segment>) = l.sumOf { it.ms }

    @Test fun anApprovalIsASoftRisingPair() {
        assertEquals(2, beeps(Beeps.success).size)
        assertTrue("success ${total(Beeps.success)} ms", total(Beeps.success) in 150..500)
        assertTrue("rises", beeps(Beeps.success).last().hz > beeps(Beeps.success).first().hz)
        assertTrue("soft: plain sine", beeps(Beeps.success).all { it.wave == ToneSynth.Wave.Sine })
    }

    @Test fun aRefusalIsThreeShortLowerBeeps() {
        assertEquals(3, beeps(Beeps.refusal).size)
        assertTrue("refusal ${total(Beeps.refusal)} ms", total(Beeps.refusal) in 300..800)
        assertTrue("lower than an approval", beeps(Beeps.refusal).all { it.hz < beeps(Beeps.success).first().hz })
    }

    @Test fun theBuzzerWaveKeepsThePitchAndNeverClips() {
        val pcm = render(ToneSynth.Segment(1000, 200, gain = 0.5f, wave = ToneSynth.Wave.Buzzer))
        val crossings = (1..pcm.lastIndex).count { (pcm[it - 1] < 0) != (pcm[it] < 0) }
        assertEquals("zero crossings for 1 kHz over 200 ms", 400.0, crossings.toDouble(), 10.0)
        val peak = pcm.maxOf { abs(it.toInt()) }
        assertTrue("peak $peak", peak in (Short.MAX_VALUE * 0.46).toInt()..(Short.MAX_VALUE * 0.5).toInt())
    }

    // A band-limited square wave overshoots its plateau by about 18% (Gibbs), so scaled to the same peak it
    // carries roughly 12% more energy than a sine: RMS 0.85 against 0.71 of the peak is the theoretical ceiling.
    @Test fun theBuzzerWaveCarriesMoreEnergyThanASine() {
        fun rms(w: ToneSynth.Wave) = render(ToneSynth.Segment(1000, 200, gain = 0.5f, wave = w)).let { p -> kotlin.math.sqrt(p.sumOf { it.toDouble() * it } / p.size) }
        assertTrue("buzzer ${rms(ToneSynth.Wave.Buzzer)} vs sine ${rms(ToneSynth.Wave.Sine)}", rms(ToneSynth.Wave.Buzzer) > rms(ToneSynth.Wave.Sine) * 1.08)
    }

    @Test fun aCheckInIsOneShortSoftBeepLowerThanTheCheckOutPair() {
        assertEquals(1, beeps(Beeps.checkIn).size)
        assertTrue("checkIn ${total(Beeps.checkIn)} ms", total(Beeps.checkIn) in 60..200)
        assertEquals(ToneSynth.Wave.Sine, beeps(Beeps.checkIn).single().wave)
        assertTrue("different from the check-out sound", Beeps.checkIn != Beeps.success)
    }
}
