package com.pont.card.ui

import com.pont.card.core.AddState
import com.pont.card.core.Notice
import com.pont.card.nfc.NfcStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CopyTest {
    @Test fun initialsSkipPunctuationAndHandleEmptyNames() {
        assertEquals("A", initialOf("anna")); assertEquals("É", initialOf("  Éva")); assertEquals("D", initialOf("\"Dóra\"")); assertEquals("?", initialOf("")); assertEquals("?", initialOf("   "))
    }

    @Test fun noticesUseTheDocumentedWords() {
        assertEquals("Offline, showing saved data", noticeText(Notice.Offline))
        assertEquals("Too many tries, wait a few minutes", noticeText(Notice.Problem("Too many tries, wait a few minutes")))
    }

    @Test fun theAddScreenExplainsNfcProblemsBeforeAnythingElse() {
        assertEquals("NFC is off", addCopy(AddState.Waiting, NfcStatus.Disabled).title)
        assertTrue(addCopy(AddState.Waiting, NfcStatus.Unsupported).message.contains("needs NFC"))
        assertEquals("NFC is off", addCopy(AddState.NotRegistered, NfcStatus.Disabled).title)
    }

    @Test fun theAddScreenHasWordsForEveryState() {
        assertEquals("This card isn't registered", addCopy(AddState.NotRegistered, NfcStatus.Ready).title)
        for (s in listOf(AddState.Waiting, AddState.Checking("u"), AddState.Added("u", "Anna", true), AddState.NotRegistered, AddState.Full, AddState.Unsupported, AddState.Error("boom", false), AddState.Error("x", true)))
            assertTrue(addCopy(s, NfcStatus.Ready).title.isNotBlank())
        assertTrue(addCopy(AddState.Error("Boom.", false), NfcStatus.Ready).message.startsWith("Boom."))
    }
}
