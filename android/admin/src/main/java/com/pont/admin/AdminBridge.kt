package com.pont.admin

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Base64
import android.webkit.JavascriptInterface

/**
 * What the admin site can ask of the app, as `window.PontNative`. The page only gets this on the admin server's own pages
 * (the activity never lets another site open in the web view). Calls arrive on a background thread.
 */
class AdminBridge(
    private val context: Context,
    private val startScan: () -> Unit,
    private val stopScan: () -> Unit,
    private val status: () -> NfcStatus,
    private val openNfcSettings: () -> Unit,
) {
    @JavascriptInterface fun startScan() = startScan.invoke()

    @JavascriptInterface fun stopScan() = stopScan.invoke()

    /** "ready", "disabled" (NFC is off in the settings) or "unsupported". */
    @JavascriptInterface fun nfcStatus(): String = status().name.lowercase()

    @JavascriptInterface fun openNfcSettings() = openNfcSettings.invoke()

    /** "ok" is one short buzz, anything else two. */
    @JavascriptInterface fun feedback(kind: String) {
        val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
        if (!vibrator.hasVibrator()) return
        val pattern = if (kind == "ok") longArrayOf(0, 40) else longArrayOf(0, 60, 80, 60)
        runCatching {
            if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1))
            else @Suppress("DEPRECATION") vibrator.vibrate(pattern, -1)
        }
    }

    /** Saves a file into Downloads. [base64] is the file's bytes. */
    @JavascriptInterface fun saveFile(name: String, mime: String, base64: String): Boolean {
        val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull() ?: return false
        return FileSaver.save(context, name, mime, bytes)
    }
}
