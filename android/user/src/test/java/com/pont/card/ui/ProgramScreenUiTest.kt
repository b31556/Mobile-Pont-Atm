package com.pont.card.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.pont.card.core.Placement
import com.pont.card.core.ProgramDay
import com.pont.card.core.ProgramDoc
import com.pont.card.core.ProgramEvent
import com.pont.card.core.ProgramGoal
import com.pont.card.core.ProgramState
import com.pont.card.core.TaskItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The program screens with real clicks and drags, run on the JVM (Robolectric): what a person presses must do what its label says.
 * The "model" here is a stand-in that changes the state the way the real one does.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
class ProgramScreenUiTest {
    @get:Rule val rule = createComposeRule()

    private val tennis = ProgramEvent("tt", "d1", "Table tennis", "Hall", "10:00", "12:00", "rate", rate = 8, block = 12, cap = 24)
    private val quiz = ProgramEvent("qz", "d1", "Quiz room", "Room 12", "09:00", "13:00", "tasks", items = listOf(TaskItem("Music", 5, 10), TaskItem("Picture", 5, 10)))
    private val chess = ProgramEvent("ch", "d1", "Chess corner", "Library", "09:00", "13:00", "rate", rate = 6, block = 10, maxMin = 90)
    private val doc = ProgramDoc("Example", listOf(ProgramDay("d1", "Day 1", "2026-01-10")), ProgramGoal(60, "d1", 30), listOf(tennis, quiz, chess))

    private var state by mutableStateOf(ProgramState(doc = doc))
    private fun start(initial: ProgramState = ProgramState(doc = doc)) {
        state = initial
        rule.setContent {
            PontCardTheme {
                ProgramScreen(
                    state, card = null, onRefresh = {},
                    onLike = { id -> state = state.copy(likes = if (id in state.likes) state.likes - id else state.likes + id) },
                    onPlace = { id, at -> state = state.copy(placed = state.placed + (id to at)) },
                    onRemove = { id -> state = state.copy(placed = state.placed - id) },
                    onSkip = { id -> state = state.copy(skipped = state.skipped + id) },
                    onUnskipAll = { state = state.copy(skipped = emptySet()) },
                )
            }
        }
    }

    private fun showAll() { rule.onNodeWithText("All").performClick() }

    /** Drags the card with real touch events to the middle of the day line. */
    private fun dragCardToLine(at: Float = 0.5f) {
        val d = Density(rule.density.density)
        val card = rule.onNodeWithTag("plancard").getBoundsInRoot()
        val line = rule.onNodeWithTag("dayline").getBoundsInRoot()
        val dx = with(d) { (line.left + line.width * at - (card.left + card.width / 2)).toPx() }
        val dy = with(d) { ((line.top + line.height / 2) - (card.top + card.height / 2)).toPx() }
        rule.onNodeWithTag("plancard").performTouchInput {
            down(center)
            moveBy(Offset(0f, 40f)); moveBy(Offset(dx / 2, dy / 2 - 20f)); moveBy(Offset(dx / 2, dy / 2 - 20f))
            up()
        }
        rule.waitForIdle()
    }

    @Test fun theScreenStartsOnPlanWithTheCardForTheFirstEvent() {
        start(); showAll()
        rule.onNodeWithText("With your plan").assertIsDisplayed()
        rule.onNodeWithText("Table tennis").assertIsDisplayed()
        rule.onNodeWithText("↓ DRAG ONTO YOUR DAY").assertIsDisplayed()
    }

    @Test fun theSkipButtonSkipsTheCardAndTheNextOneComesUp() {
        start(); showAll()
        rule.onNodeWithContentDescription("Skip Table tennis").performClick()
        assertEquals(setOf("tt"), state.skipped)
        rule.onNodeWithContentDescription("Skip Chess corner").assertIsDisplayed()      // open all morning with the most points: next
        rule.onNodeWithText("1 skipped").assertIsDisplayed()
    }

    @Test fun swipingTheCardToTheLeftSkipsIt() {
        start(); showAll()
        rule.onNodeWithTag("plancard").performTouchInput { swipeLeft() }
        rule.waitForIdle()
        assertEquals(setOf("tt"), state.skipped)
        assertTrue(state.placed.isEmpty())
    }

    @Test fun broughtBackSkippedEventsComeUpAgain() {
        start(ProgramState(doc = doc, skipped = setOf("tt", "qz", "ch"))); showAll()
        rule.onNodeWithText("3 skipped").assertIsDisplayed()
        rule.onNodeWithText("No more cards", substring = true).assertIsDisplayed()
        rule.onNodeWithText("Bring back").performClick()
        assertTrue(state.skipped.isEmpty())
        rule.onNodeWithContentDescription("Skip Table tennis").assertIsDisplayed()
    }

    @Test fun draggingTheCardOntoTheLinePlansItInsideItsHours() {
        start(); showAll()
        dragCardToLine()
        val at = state.placed["tt"]
        assertNotNull("the card should have been planned", at)
        assertEquals(36, at!!.dur)                                    // 3 blocks of 12 minutes reach the 24 point cap
        assertTrue(at.start >= 600 && at.end <= 720)                  // inside 10:00-12:00
        rule.onAllNodesWithText("+24", substring = true).onFirst().assertIsDisplayed()      // in the block, and in the panel
    }

    @Test fun droppingTheCardAwayFromTheLinePlansNothing() {
        start(); showAll()
        rule.onNodeWithTag("plancard").performTouchInput { down(center); moveBy(Offset(0f, -60f)); moveBy(Offset(0f, -20f)); up() }
        rule.waitForIdle()
        assertTrue(state.placed.isEmpty()); assertTrue(state.skipped.isEmpty())
    }

    @Test fun theButtonsOfAPlannedStayAllWork() {
        start(); showAll(); dragCardToLine()
        assertEquals(36, state.placed["tt"]!!.dur)
        rule.onNodeWithText("+ 5 min").performClick()
        assertEquals(41, state.placed["tt"]!!.dur)
        rule.onNodeWithText("− 5 min").performClick()
        assertEquals(36, state.placed["tt"]!!.dur)
        rule.onNodeWithText("Details").performClick()
        rule.onNodeWithText("In your plan at", substring = true).assertIsDisplayed()      // the sheet opened
    }

    @Test fun removeTakesTheStayOutOfThePlan() {
        start(); showAll(); dragCardToLine()
        assertNotNull(state.placed["tt"])
        rule.onNodeWithText("Remove").performClick()
        assertNull(state.placed["tt"])
        rule.onNodeWithText("Table tennis").assertIsDisplayed()           // it is a card again
    }

    @Test fun tappingAPlannedStayInTheListSelectsItAndShowsItsButtons() {
        start(ProgramState(doc = doc, placed = mapOf("tt" to Placement(600, 36))))
        rule.onNodeWithText("10:00–10:36 · Table tennis").performClick()
        rule.onNodeWithText("Remove").assertIsDisplayed(); rule.onNodeWithText("Details").assertIsDisplayed()
        rule.onNodeWithText("Remove").performClick()
        assertTrue(state.placed.isEmpty())
    }

    @Test fun theHeartLikesAndUnlikesAnEvent() {
        start(); showAll()
        rule.onNodeWithContentDescription("Like Table tennis").performClick()
        assertEquals(setOf("tt"), state.likes)
        rule.onNodeWithContentDescription("Like Table tennis").performClick()
        assertTrue(state.likes.isEmpty())
    }

    @Test fun pulseShowsTheEarnedPointsAndWhatIsOpen() {
        start()
        rule.onNodeWithText("Pulse").performClick()
        rule.onNodeWithText("Earned so far").assertIsDisplayed()
        rule.onNodeWithText("Table tennis").assertIsDisplayed()
    }

    @Test fun inPulseTheSheetAddsTheEventToTheDay() {
        start()
        rule.onNodeWithText("Pulse").performClick()
        rule.onNodeWithText("Table tennis").performClick()
        rule.onNodeWithText("Add to my day at", substring = true).performClick()
        assertNotNull(state.placed["tt"])
        rule.onNodeWithText("With your plan").assertIsDisplayed()           // back on Plan, showing it
    }

    @Test fun inPulseTheHeartLikes() {
        start()
        rule.onNodeWithText("Pulse").performClick()
        rule.onNodeWithContentDescription("Like Table tennis").performClick()
        assertTrue("tt" in state.likes)
    }

    @Test fun switchingTabsKeepsWhatWasPlanned() {
        start(ProgramState(doc = doc, placed = mapOf("tt" to Placement(600, 36))))
        rule.onNodeWithText("Pulse").performClick(); rule.onNodeWithText("Plan").performClick()
        rule.onNodeWithText("10:00–10:36 · Table tennis").assertIsDisplayed()
        assertFalse(state.placed.isEmpty())
    }
}
