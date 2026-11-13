package ai.kilo.reactnativessh.terminal

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.sharedobjects.SharedObject
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/**
 * A [TerminalByteSource] whose bytes travel to and from JavaScript, for terminals whose backend is a
 * JavaScript transport such as a WebSocket.
 *
 * The sink is driven on the main thread; [feed] and [close] may be called from any thread.
 */
class FeedSource(appContext: AppContext) : SharedObject(appContext), TerminalByteSource {

  val id: String = UUID.randomUUID().toString()

  private val sink = AtomicReference<TerminalSink?>(null)
  private val mainHandler = Handler(Looper.getMainLooper())

  init {
    TerminalSourceRegistry.register(id, this)
  }

  override fun write(bytes: ByteArray) {
    emit("onInput", bytes)
  }

  override fun resize(cols: Int, rows: Int) {
    emit("onResize", Bundle().apply {
      putInt("cols", cols)
      putInt("rows", rows)
    })
  }

  override fun setSink(sink: TerminalSink?) {
    this.sink.set(sink)
  }

  fun feed(bytes: ByteArray) {
    mainHandler.post { sink.get()?.onData(bytes) }
  }

  fun close(exitStatus: Int?, error: String?) {
    mainHandler.post { sink.get()?.onClosed(exitStatus, error) }
  }

  override fun sharedObjectDidRelease() {
    TerminalSourceRegistry.unregister(id)
    super.sharedObjectDidRelease()
  }
}
