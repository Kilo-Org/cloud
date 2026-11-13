package ai.kilo.reactnativessh.background

import android.content.Context
import android.os.Handler
import android.os.Looper

internal data class SessionTexts(
  val channelName: String,
  val title: String,
  val disconnectAllLabel: String,
)

/**
 * The open-session state the background notification renders, and the only
 * owner of the service lifecycle: it starts on the first session and stops with
 * the last one.
 *
 * `update` arrives from the module's coroutines and from the core's disconnect
 * callback, so the count, the transition it implies and the queued action all
 * fall under one lock: two interleaved transitions would otherwise post a stop
 * for a start that had not been posted yet.
 */
internal object BackgroundSessions {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val lock = Any()

  @Volatile var texts = SessionTexts("SSH sessions", "SSH session active", "Disconnect all")
    private set

  @Volatile var body = ""
    private set

  @Volatile private var count = 0

  /** Invoked from the notification action; set by the module that owns the sessions. */
  var disconnectAll: (() -> Unit)? = null

  fun configure(context: Context, channelName: String, title: String, disconnectAllLabel: String): Int {
    texts = SessionTexts(channelName, title, disconnectAllLabel)
    mainHandler.post { refresh(context) }

    return count
  }

  fun setBody(context: Context, next: String) {
    body = next
    mainHandler.post { refresh(context) }
  }

  fun update(context: Context, next: Int) {
    val action = synchronized(lock) {
      val opened = count == 0 && next > 0
      val closed = count > 0 && next == 0
      count = next

      when {
        opened -> Runnable { SshSessionService.start(context) }
        closed -> Runnable { SshSessionService.stop(context) }
        else -> Runnable { refresh(context) }
      }
    }

    mainHandler.post(action)
  }

  private fun refresh(context: Context) {
    if (count > 0) SessionNotifications.postOngoing(context)
  }
}
