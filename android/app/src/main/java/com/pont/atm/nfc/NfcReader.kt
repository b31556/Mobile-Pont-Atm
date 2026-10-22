package com.pont.atm.nfc

import android.app.Activity
import android.nfc.NfcAdapter
import android.nfc.Tag
import com.pont.atm.core.formatUid

enum class NfcStatus { Ready, Disabled, Unsupported }

/**
 * Reads the UID of any ISO 14443-3A tag (which covers MIFARE Classic 1K) while enabled.
 * Reader mode only needs the tag's UID, so it works on every NFC phone, including ones whose chip
 * cannot authenticate to MIFARE Classic sectors. Platform sounds are off because the app beeps itself.
 */
class NfcReader(private val activity: Activity) {
    private val adapter: NfcAdapter? = NfcAdapter.getDefaultAdapter(activity)

    fun status(): NfcStatus = when {
        adapter == null -> NfcStatus.Unsupported
        !adapter.isEnabled -> NfcStatus.Disabled
        else -> NfcStatus.Ready
    }

    /** [onUid] is called on a background thread with the canonical UID string. Safe to call when NFC is off. */
    fun enable(onUid: (String) -> Unit) {
        runCatching { adapter?.enableReaderMode(
            activity,
            { tag: Tag -> formatUid(tag.id)?.let(onUid) },
            NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS,
            null,
        ) }
    }

    fun disable() {
        runCatching { adapter?.disableReaderMode(activity) }
    }
}
