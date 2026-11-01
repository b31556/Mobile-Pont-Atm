package com.pont.card

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.pont.card.nfc.NfcReader
import com.pont.card.ui.AppRoot
import com.pont.card.ui.PontCardTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = (application as CardApp).graph
        val reader = NfcReader(this)
        setContent { PontCardTheme { AppRoot(graph, reader) } }
    }
}
