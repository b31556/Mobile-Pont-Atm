package com.pont.atm

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.pont.atm.nfc.NfcReader
import com.pont.atm.ui.AppNav
import com.pont.atm.ui.PontTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = (application as PontApp).graph
        val reader = NfcReader(this)
        setContent { PontTheme { AppNav(graph, reader) } }
    }
}
