package com.pont.card.nfc

import android.app.Activity
import android.nfc.NfcAdapter
import android.nfc.Tag

enum class NfcStatus { Ready, Disabled, Unsupported }

/**
 * Reads the UID of any NFC tag while enabled. Reader mode only needs the tag's id, so it works on every NFC
 * phone and on cards a phone can't otherwise authenticate to. The system's own tag sound stays on, because
 * this app plays none.
 */
class NfcReader(private val activity: Activity) {
    private val adapter: NfcAdapter? = NfcAdapter.getDefaultAdapter(activity)

    fun status(): NfcStatus = when {
        adapter == null -> NfcStatus.Unsupported
        !adapter.isEnabled -> NfcStatus.Disabled
        else -> NfcStatus.Ready
    }

    /** [onTagId] is called on a background thread with `Tag.getId()`. Safe to call when NFC is off or missing. */
    fun enable(onTagId: (ByteArray) -> Unit) {
        runCatching {
            adapter?.enableReaderMode(
                activity,
                { tag: Tag -> onTagId(tag.id) },
                NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or NfcAdapter.FLAG_READER_NFC_F or
                    NfcAdapter.FLAG_READER_NFC_V or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
                null,
            )
        }
    }

    fun disable() {
        runCatching { adapter?.disableReaderMode(activity) }
    }
}
