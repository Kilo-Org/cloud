package ai.kilo.reactnativessh.terminal

import android.os.Handler
import android.os.Looper
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Process-wide lookup from the `sourceId` prop to the [TerminalByteSource] that serves it.
 *
 * Views subscribe while they are attached so a source registered after the view mounts still binds.
 */
object TerminalSourceRegistry {

  private val sources = ConcurrentHashMap<String, TerminalByteSource>()
  private val listeners = CopyOnWriteArrayList<() -> Unit>()
  private val mainHandler = Handler(Looper.getMainLooper())

  fun register(sourceId: String, source: TerminalByteSource) {
    sources[sourceId] = source
    notifyListeners()
  }

  fun unregister(sourceId: String) {
    sources.remove(sourceId)
    notifyListeners()
  }

  fun find(sourceId: String): TerminalByteSource? = sources[sourceId]

  fun addListener(listener: () -> Unit) {
    listeners.add(listener)
  }

  fun removeListener(listener: () -> Unit) {
    listeners.remove(listener)
  }

  private fun notifyListeners() {
    mainHandler.post { listeners.forEach { it() } }
  }
}
