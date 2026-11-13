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
 */
internal object BackgroundSessions {
  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile var texts = SessionTexts("SSH sessions", "SSH session active", "Disconnect all")
    private set

  @Volatile var body = ""
    private set

  @Volatile private var count = 0

  /** Invoked from the notification action; set by the module that owns the sessions. */
  var disconnectAll: (() -> Unit)? = null

  fun configure(context: Context, channelName: String, title: String, disconnectAllLabel: String): Int {
    texts = SessionTexts(channelName, title, disconnectAllLabel)
    refresh(context)

    return count
  }

  fun setBody(context: Context, next: String) {
    body = next
    refresh(context)
  }

  fun update(context: Context, next: Int) {
    val opened = count == 0 && next > 0
    val closed = count > 0 && next == 0
    count = next

    when {
      opened -> mainHandler.post { SshSessionService.start(context) }
      closed -> mainHandler.post { SshSessionService.stop(context) }
      else -> refresh(context)
    }
  }

  private fun refresh(context: Context) {
    mainHandler.post { if (count > 0) SessionNotifications.postOngoing(context) }
  }
}
