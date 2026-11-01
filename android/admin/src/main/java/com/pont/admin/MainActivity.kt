package com.pont.admin

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Pont Admin: the admin site in a full-screen web view, plus the phone's card reader. The site shows a scan button next to the
 * search box and the card UID field; pressing it calls `PontNative.startScan()`, and the card that is held to the phone comes back
 * as `window.pontScanned("04:A2:3B:1C")`. Nothing is read while the site has not asked.
 */
class MainActivity : Activity() {
    private val base = BuildConfig.DEFAULT_BASE_URL.trimEnd('/')
    private val home = "$base/admin/"

    private lateinit var web: WebView
    private lateinit var offline: View
    private lateinit var nfc: NfcReader
    private var scanning = false
    private var loadFailed = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        nfc = NfcReader(this)

        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#F7F9FA"))
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true            // the admin site keeps its sign-in in sessionStorage
                allowFileAccess = false
                allowContentAccess = false
                setSupportZoom(false)
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                userAgentString = "$userAgentString PontAdminApp/${BuildConfig.VERSION_NAME}"
            }
            addJavascriptInterface(
                AdminBridge(
                    context = this@MainActivity,
                    startScan = { runOnUiThread { scanning = true; enableReader() } },
                    stopScan = { runOnUiThread { scanning = false; nfc.disable() } },
                    status = { nfc.status() },
                    openNfcSettings = { runOnUiThread { runCatching { startActivity(Intent(Settings.ACTION_NFC_SETTINGS)) } } },
                ),
                "PontNative",
            )
            webViewClient = client()
            webChromeClient = chooser()
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        offline = offlineView()

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#12202B"))
            addView(web, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            addView(offline, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        if (savedInstanceState == null) web.loadUrl(home)
    }

    private fun client() = object : WebViewClient() {
        // Only the admin server's own pages open here. Any other address goes to the phone's browser.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (isSameOrigin(url, base)) return false
            if (isWebAddress(url)) runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
            return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) { loadFailed = false }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) { loadFailed = true; offline.visibility = View.VISIBLE }
        }

        override fun onPageFinished(view: WebView, url: String) { if (!loadFailed) offline.visibility = View.GONE }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            runOnUiThread { recreate() }   // the web view's process died: start a fresh one instead of crashing
            return true
        }
    }

    /** The site's photo field opens the phone's file or photo picker. */
    private fun chooser() = object : WebChromeClient() {
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try { @Suppress("DEPRECATION") startActivityForResult(params.createIntent(), REQUEST_FILE); true }
            catch (e: Exception) { fileCallback = null; false }
        }
    }

    private fun offlineView(): View {
        val message = TextView(this).apply {
            text = "Can’t reach the server.\nCheck the internet connection."
            setTextColor(Color.parseColor("#12202B")); textSize = 18f; gravity = Gravity.CENTER
        }
        val retry = Button(this).apply {
            text = "Try again"
            setOnClickListener { loadFailed = false; offline.visibility = View.GONE; web.loadUrl(home) }
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#F7F9FA")); setPadding(48, 48, 48, 48)
            addView(message, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = 32 })
            addView(retry)
            visibility = View.GONE
        }
    }

    private fun enableReader() {
        nfc.enable { id ->
            val uid = formatUid(id) ?: ""   // a tag that is not a card gives "", and the page says so
            runOnUiThread { if (scanning) web.evaluateJavascript("window.pontScanned && window.pontScanned(${jsString(uid)})", null) }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQUEST_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        } else @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onResume() { super.onResume(); web.onResume(); if (scanning) enableReader() }

    override fun onPause() { nfc.disable(); web.onPause(); super.onPause() }

    override fun onDestroy() {
        fileCallback?.onReceiveValue(null)
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    /** Back closes what is open on the page (the scan sheet, a window, a report) before it leaves the app. */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("(window.pontBack && window.pontBack()) === true") { handled ->
            if (handled == "true") return@evaluateJavascript
            if (offline.visibility == View.VISIBLE || !web.canGoBack()) moveTaskToBack(true) else web.goBack()
        }
    }

    private companion object { const val REQUEST_FILE = 1 }
}
