package com.pont.atm.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
private fun Logo() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(40.dp).background(PontColors.Amber, CircleShape), contentAlignment = Alignment.Center) {
            Text("P", style = PontType.display(22))
        }
        Text("Pont", style = PontType.display(28))
    }
}

@Composable
private fun Field(value: String, onChange: (String) -> Unit, label: String, modifier: Modifier = Modifier,
                  keyboard: KeyboardType = KeyboardType.Text, secret: Boolean = false) {
    OutlinedTextField(
        value = value, onValueChange = onChange, label = { Text(label) }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard),
        visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = PontColors.Ink, unfocusedBorderColor = PontColors.Line,
            focusedContainerColor = PontColors.Paper, unfocusedContainerColor = PontColors.Paper),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
        modifier = modifier.fillMaxWidth(),
    )
}

@Composable
fun PairScreen(busy: Boolean, error: String?, onPair: (code: String) -> Unit) {
    var code by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Logo(); Spacer(Modifier.height(12.dp))
        Text("Pair this phone", style = PontType.display(32))
        Text("Ask an admin for a pairing code. They create it under Terminals on the admin site. There is nothing to sign in to after that.", color = PontColors.Ink2)
        Field(code, { code = it.filter(Char::isDigit).take(6) }, "6-digit code", keyboard = KeyboardType.NumberPassword)
        if (error != null) Text(error, color = PontColors.Red, fontWeight = FontWeight.SemiBold)
        GoButton(if (busy) "Pairing…" else "Pair this phone", enabled = !busy && code.length == 6) { onPair(code) }
    }
}

