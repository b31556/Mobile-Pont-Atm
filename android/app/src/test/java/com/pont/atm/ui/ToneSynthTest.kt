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

    @Test fun successAndRefusalSoundsAreShortAndDifferent() {
        val ok = Beeps.success.sumOf { it.ms }; val bad = Beeps.refusal.sumOf { it.ms }
        assertTrue("success $ok ms", ok in 150..500)
        assertTrue("refusal $bad ms", bad in 150..700)
        assertTrue(Beeps.success != Beeps.refusal)
        assertTrue("success rises", Beeps.success.filter { it.hz > 0 }.let { it.last().hz > it.first().hz })
        assertTrue("refusal falls", Beeps.refusal.filter { it.hz > 0 }.let { it.last().hz < it.first().hz })
    }
}
