package com.pont.atm.ui

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.pont.atm.core.CancelState
import com.pont.atm.core.CardInfo
import com.pont.atm.core.ChargeOutcome
import com.pont.atm.core.FlowState
import com.pont.atm.core.InMemorySessionStore
import com.pont.atm.core.PontApi
import com.pont.atm.core.PresenceCard
import com.pont.atm.core.PresenceOutcome
import com.pont.atm.core.PresenceResult
import com.pont.atm.core.PresenceState
import com.pont.atm.core.PresenceToday
import com.pont.atm.core.TxInfo
import com.pont.atm.core.ZoneRef
import org.junit.Assume
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.Instant

/**
 * Pictures of the real Pont Terminal screens for the README and the website, drawn on the JVM (Robolectric native graphics,
 * no phone and no emulator). Invented data only. It skips itself unless PONT_SCREENSHOTS is set. To make the pictures:
 *
 *   cd android && PONT_SCREENSHOTS=1 PONT_SCREENSHOTS_DIR=../server/public/site/img/raw \
 *     ./gradlew :app:testDebugUnitTest --tests com.pont.atm.ui.ScreenshotsTest --rerun-tasks
 *
 * (PONT_SCREENSHOTS_DIR defaults to build/screenshots under :app.)
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
class ScreenshotsTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val outDir: File = File(System.getenv("PONT_SCREENSHOTS_DIR") ?: "build/screenshots").also { it.mkdirs() }
    private val api = PontApi(InMemorySessionStore())      // no address: no photo is ever fetched, the app draws the initial

    private fun on() = Assume.assumeTrue(System.getenv("PONT_SCREENSHOTS") != null)

    private fun show(name: String, c: @Composable () -> Unit) {
        rule.setContent { PontTheme { Surface(color = PontColors.Bg, contentColor = PontColors.Ink) { androidx.compose.foundation.layout.Box(androidx.compose.ui.Modifier.fillMaxSize().statusBarsPadding()) { c() } } } }
        rule.waitForIdle()
        val view = rule.activity.window.decorView
        val bmp = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(android.graphics.Canvas(bmp))
        File(outDir, "$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun give() {
        on()
        val pad = NumpadState().apply { press('2'); press('4') }
        show("terminal-give") { ChargeScreen(pad, listOf(5, 10, 20, 50), instant = false, terminal = "Snack bar", online = true, onPreset = {}, onCharge = {}, onMenu = {}) }
    }

    @Test fun result() {
        on()
        val done = FlowState.Done(24, ChargeOutcome.Success(TxInfo(1043, 24, Instant.now().toString(), "Snack bar"), CardInfo("c1", "Anna Kovács", "", 104, 128)), "04A1B2C3D4E5F6")
        show("terminal-result") { ResultScreen(done, api, "Snack bar", {}, {}, {}, { Result.failure(Exception()) }, { Result.success(Unit) }) }
    }

    @Config(sdk = [35], qualifiers = "w411dp-h520dp-xxhdpi")
    @Test fun checkin() {
        on()
        val now = Instant.now()
        val r = PresenceResult("in", PresenceCard("c2", "Béla Szabó", "", 74), inAt = now.toString(), today = PresenceToday(12, 40), zone = ZoneRef("z1", "Table tennis"))
        val state = PresenceState.Showing("04B1B2C3D4E5F6", PresenceOutcome.Done(r), now.toEpochMilli())
        show("terminal-checkin") { PresenceScreen(state, api, "Table tennis door", "in", "Table tennis", CancelState.Idle, {}, {}, {}, {}, {}, {}) }
    }
}
