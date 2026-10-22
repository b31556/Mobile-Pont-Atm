package com.pont.atm.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Debug builds only: pretend a card was tapped, for emulators without NFC. */
@Composable
fun DebugTapButtons(onUid: (String) -> Unit) {
    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        listOf("04:A2:3B:1C", "04:EE:00:77").forEach { uid ->
            Text("debug tap $uid", color = Color(0xFF6C808D), fontSize = 11.sp, modifier = Modifier.clickable { onUid(uid) }.padding(8.dp))
        }
    }
}
