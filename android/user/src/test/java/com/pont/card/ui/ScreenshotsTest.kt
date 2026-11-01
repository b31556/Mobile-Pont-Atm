package com.pont.card.ui

import android.graphics.Bitmap
import androidx.compose.ui.test.captureToImage
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.pont.card.core.CardItem
import com.pont.card.core.HistoryEntry
import com.pont.card.core.HomeState
import com.pont.card.core.ItemState
import com.pont.card.core.Placement
import com.pont.card.core.ProgramDay
import com.pont.card.core.ProgramDoc
import com.pont.card.core.ProgramEvent
import com.pont.card.core.ProgramGoal
import com.pont.card.core.ProgramState
import com.pont.card.core.PublicCard
import com.pont.card.core.TaskItem
import com.pont.card.nfc.NfcStatus
import org.junit.Assume
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale

/**
 * Pictures of the real Pont Card screens for the README and the website, drawn on the JVM (Robolectric native graphics,
 * no phone and no emulator). Invented data only. It skips itself unless PONT_SCREENSHOTS is set. To make the pictures:
 *
 *   cd android && PONT_SCREENSHOTS=1 PONT_SCREENSHOTS_DIR=../server/public/site/img/raw \
 *     ./gradlew :user:testDebugUnitTest --tests com.pont.card.ui.ScreenshotsTest --rerun-tasks
 *
 * (PONT_SCREENSHOTS_DIR defaults to build/screenshots under :user.)
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
class ScreenshotsTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val outDir: File = File(System.getenv("PONT_SCREENSHOTS_DIR") ?: "build/screenshots").also { it.mkdirs() }

    private fun shoot(name: String) {
        rule.waitForIdle()
        val view = rule.activity.window.decorView
        val bmp = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(android.graphics.Canvas(bmp))
        File(outDir, "$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun on() = Assume.assumeTrue(System.getenv("PONT_SCREENSHOTS") != null)

    private val yesterday = LocalDate.now().minusDays(1)
    private val tomorrow = LocalDate.now().plusDays(1)
    private fun at(d: LocalDate, hm: String) = "${d}T$hm:00Z"

    private val history = listOf(
        HistoryEntry(at(yesterday, "09:40"), "atm", 10, "Welcome desk"),
        HistoryEntry(at(yesterday, "10:50"), "presence", 12, "Table tennis", "36 min"),
        HistoryEntry(at(yesterday, "11:30"), "fixed", 5, "Quiz room"),
        HistoryEntry(at(yesterday, "12:10"), "presence", 15, "Quiz room", "30 min"),
        HistoryEntry(at(yesterday, "13:05"), "adjust", 5, note = "Bonus: chess match won"),
        HistoryEntry(at(yesterday, "14:20"), "atm", -6, "Snack bar"),
        HistoryEntry(at(yesterday, "15:30"), "presence", 18, "Robot workshop", "45 min"),
        HistoryEntry(at(yesterday.minusDays(1), "16:15"), "atm", 8, "Opening show"),
        HistoryEntry(at(yesterday.minusDays(1), "17:00"), "fixed", 10, "Welcome desk"),
    )
    private val card = PublicCard("04A1B2C3D4E5F6", true, "Anna Kovács", "active", 128, null, history)
    private val item = CardItem(card.uid, card, ItemState.Fresh)

    // The example program of the server (server/src/program-default.ts), with its days put around today.
    private fun dayName(d: LocalDate) = d.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.ENGLISH)
    private val doc = ProgramDoc(
        "Example event",
        listOf(ProgramDay("day1", dayName(yesterday), yesterday.toString()), ProgramDay("day2", dayName(tomorrow), tomorrow.toString())),
        ProgramGoal(60, "day2", 30),
        listOf(
            ProgramEvent("table-tennis", "day1", "Table tennis", "Hall", "10:00", "12:00", "rate", rate = 8, block = 12, cap = 24, rule = "8 points per 12 minutes, up to 24 points."),
            ProgramEvent("opening", "day1", "Opening show", "Main hall", "15:00", "16:00", "flat", cap = 10, rule = "10 points for everyone who stays until the end."),
            ProgramEvent("quiz-room", "day2", "Quiz room", "Room 12", "09:00", "13:00", "tasks",
                items = listOf(TaskItem("Music quiz", 5, 10), TaskItem("Picture quiz", 5, 10), TaskItem("Team round", 8, 15)), rule = "Three quizzes, each with its own points."),
            ProgramEvent("chess", "day2", "Chess corner", "Library", "09:00", "13:00", "rate", rate = 6, block = 10, maxMin = 90, rule = "6 points per 10 minutes, for at most 90 minutes.", bonus = "+2 points for each match won"),
            ProgramEvent("workshop", "day2", "Robot workshop", "Lab", "10:00", "11:30", "tasks",
                items = listOf(TaskItem("Build", 12, 30), TaskItem("Race", 6, 15)), rule = "Build a robot, then race it.", bring = "Bring a pen"),
        ),
    )
    private val program = ProgramState(
        doc = doc,
        likes = setOf("chess", "quiz-room", "workshop"),
        placed = mapOf("quiz-room" to Placement(540, 30), "workshop" to Placement(600, 45), "chess" to Placement(660, 40)),
    )

    private fun content(c: @androidx.compose.runtime.Composable () -> Unit) = rule.setContent { PontCardTheme { c() } }

    @Config(sdk = [35], qualifiers = "w411dp-h330dp-xxhdpi")
    @Test fun home() {
        on()
        content { HomeScreen(HomeState(items = listOf(item)), NfcStatus.Ready, {}, {}, {}) }
        shoot("app-card")
    }

    @Config(sdk = [35], qualifiers = "w411dp-h1260dp-xxhdpi")
    @Test fun history() {
        on()
        content { DetailScreen(item, null, false, {}, {}, {}) }
        shoot("app-history")
    }

    private fun program(tab: String, state: ProgramState = program, name: String? = null) {
        content { ProgramScreen(state, card, {}, {}, { _, _ -> }, {}) }
        rule.onNodeWithText(dayName(tomorrow)).performClick()
        if (tab == "Pulse") rule.onNodeWithText("Pulse").performClick() else rule.onNodeWithText("All").performClick()
        shoot(name ?: if (tab == "Pulse") "app-pulse" else "app-plan")
    }

    @Config(sdk = [35], qualifiers = "w411dp-h620dp-xxhdpi")
    @Test fun plan() { on(); program("Plan") }
    /** Plan with a card still to place: two stays are on the line, the Chess corner card waits to be dragged. */
    @Config(sdk = [35], qualifiers = "w411dp-h730dp-xxhdpi")
    @Test fun planWithCard() { on(); program("Plan", program.copy(placed = program.placed - "chess"), "app-plan-card") }
    @Config(sdk = [35], qualifiers = "w411dp-h760dp-xxhdpi")
    @Test fun pulse() { on(); program("Pulse") }
}
