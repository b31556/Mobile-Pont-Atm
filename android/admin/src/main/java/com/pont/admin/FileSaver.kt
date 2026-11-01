package com.pont.admin

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/** Saves a file the admin site made (the Excel exports) into the phone's Downloads folder. */
object FileSaver {
    private const val MAX_BYTES = 20 * 1024 * 1024

    /** Returns true when the file was saved. [name] is cleaned first, so a page can't write outside Downloads. */
    fun save(context: Context, name: String, mime: String, bytes: ByteArray): Boolean {
        if (bytes.size > MAX_BYTES) return false
        val fileName = safeFileName(name)
        return runCatching {
            if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                    put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = context.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
                resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return false
                resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            } else {
                // Before Android 10 writing to the shared Downloads folder needs a permission this app does not ask for: use its own folder.
                val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return false
                dir.mkdirs()
                File(dir, fileName).writeBytes(bytes)
            }
            true
        }.getOrDefault(false)
    }
}
