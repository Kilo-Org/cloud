package ai.kilo.reactnativessh

import ai.kilo.reactnativessh.terminal.TerminalByteSource
import ai.kilo.reactnativessh.terminal.TerminalSink
import ai.kilo.reactnativessh.uniffi.ByteSink
import ai.kilo.reactnativessh.uniffi.ShellChannel
import ai.kilo.reactnativessh.uniffi.SshException
import ai.kilo.reactnativessh.uniffi.SshSession
import java.util.concurrent.CopyOnWriteArrayList

/**
 * A shell channel as the terminal view sees it: bytes go straight from Rust to
 * the view, and input comes back the same way. Nothing crosses JavaScript.
 *
 */
internal class SshShellSource private constructor(
  val sessionId: String,
  private val channel: ShellChannel,
  private val delivery: SinkDelivery,
  val activity: ShellActivity,
) : TerminalByteSource {
  /** Set only after a sink received the exit; unbound closed shells remain attachable. */
  val terminated: Boolean
    get() = delivery.terminated

  override fun write(bytes: ByteArray) {
    try {
      channel.write(bytes)
    } catch (error: SshException.ChannelClosed) {
      delivery.onClosed(null, error.message ?: "shell channel is closed")
    }
  }

  override fun resize(cols: Int, rows: Int) {
    try {
      channel.resize(cols.toUInt(), rows.toUInt())
    } catch (error: SshException.ChannelClosed) {
      delivery.onClosed(null, error.message ?: "shell channel is closed")
    }
  }

  override fun setSink(sink: TerminalSink?) {
    delivery.bind(sink)
  }

  fun close() {
    try {
      channel.shutdown()
    } catch (_: SshException) {
      // The channel is already gone when the transport died first.
    }
  }

  companion object {
    /**
     * [onTerminated] runs once, on the thread that delivers the channel's exit,
     * after the bound sink has seen the close. It must not block.
     */
    suspend fun open(
      sessionId: String,
      session: SshSession,
      term: String,
      cols: Int,
      rows: Int,
      onTerminated: () -> Unit,
    ): SshShellSource {
      val activity = ShellActivity()
      val delivery = SinkDelivery(activity, onTerminated)
      val channel = session.openShell(term, cols.toUInt(), rows.toUInt(), delivery)

      return SshShellSource(sessionId, channel, delivery, activity)
    }
  }
}

/**
 * Output arrivals of one shell channel, as the background session notifications
 * observe them. Listeners run on the thread that delivers the bytes.
 */
internal class ShellActivity {
  private val listeners = CopyOnWriteArrayList<() -> Unit>()

  fun markOutput() {
    listeners.forEach { it() }
  }

  fun addListener(listener: () -> Unit) {
    listeners.add(listener)
  }

  fun removeListener(listener: () -> Unit) {
    listeners.remove(listener)
  }
}

/**
 * Bridges the core's output callback to the view's sink.
 *
 * The view attaches after the shell is opened, so bytes that arrive first are
 * buffered up to [MAX_BUFFERED_BYTES] and delivered on `bind`.
 */
internal class SinkDelivery(
  private val activity: ShellActivity,
  private val onTerminated: () -> Unit,
) : ByteSink {
  private val lock = Any()
  private var sink: TerminalSink? = null
  private var buffered: MutableList<ByteArray>? = ArrayList()
  private var bufferedBytes = 0
  private var closeEvent: CloseEvent? = null

  /** Written under [lock] and read from the module, which owns the source. */
  @Volatile var terminated = false
    private set

  fun bind(next: TerminalSink?) {
    val pending: List<ByteArray>
    val closed: CloseEvent?

    synchronized(lock) {
      sink = next
      pending = if (next == null) emptyList() else buffered ?: emptyList()
      closed = closeEvent
      if (next != null) {
        buffered = ArrayList()
        bufferedBytes = 0
      }
    }

    if (next == null) {
      return
    }

    pending.forEach(next::onData)
    closed?.let {
      next.onClosed(it.exitStatus, it.error)
      deliveredClose()
    }
  }

  override fun onData(bytes: ByteArray) {
    activity.markOutput()

    val target = synchronized(lock) {
      val current = sink
      if (current == null) {
        buffer(bytes)
      }
      current
    }

    target?.onData(bytes)
  }

  override fun onClosed(exitStatus: UInt?, error: String?) {
    val target = synchronized(lock) {
      if (closeEvent != null) return
      closeEvent = CloseEvent(exitStatus?.toInt(), error)
      sink
    }

    if (target != null) {
      target.onClosed(exitStatus?.toInt(), error)
      deliveredClose()
    }
  }

  private fun deliveredClose() {
    val first = synchronized(lock) {
      if (terminated) false else {
        terminated = true
        true
      }
    }
    if (first) onTerminated()
  }

  private fun buffer(bytes: ByteArray) {
    val pending = buffered ?: return
    if (bufferedBytes + bytes.size > MAX_BUFFERED_BYTES) {
      return
    }
    pending.add(bytes)
    bufferedBytes += bytes.size
  }

  private class CloseEvent(val exitStatus: Int?, val error: String?)

  private companion object {
    const val MAX_BUFFERED_BYTES = 64 * 1024
  }
}
