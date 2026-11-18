package expo.modules.kilofilehash

import android.net.Uri
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.FileInputStream
import java.security.MessageDigest

private const val CHUNK_BYTES = 1024 * 1024

class KiloFileHashModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KiloFileHash")

    // Async functions run on a background thread, off the JS and main threads.
    AsyncFunction("sha256File") { uri: String ->
      val path = Uri.parse(uri).path ?: throw CodedException("The file URI has no path.")
      val digest = MessageDigest.getInstance("SHA-256")
      val buffer = ByteArray(CHUNK_BYTES)
      FileInputStream(path).use { input ->
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          digest.update(buffer, 0, read)
        }
      }
      digest.digest().joinToString("") { "%02x".format(it) }
    }
  }
}
