package com.pont.atm.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProcessingTimingTest {
    @Test fun anInstantAnswerStillShowsTheBarBriefly() = assertEquals(ProcessingTiming.MIN_MS, ProcessingTiming.remaining(0))
    @Test fun nothingMoreToWaitOnceTheMinimumHasPassed() = assertEquals(0L, ProcessingTiming.remaining(ProcessingTiming.MIN_MS + 1))
    @Test fun aSlowAnswerIsNeverDelayedFurther() = assertEquals(0L, ProcessingTiming.remaining(3000))
    @Test fun theWaitIsUnderHalfASecond() = assertTrue(ProcessingTiming.MIN_MS in 200..500)
    @Test fun theBarStagesFitInsideTheMinimum() = assertTrue(ProcessingTiming.STAGE_MS * 2 <= ProcessingTiming.MIN_MS)
}
