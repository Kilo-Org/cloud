package ai.kilo.reactnativessh.background

import ai.kilo.reactnativessh.SshRegistry
import android.content.Context
import android.os.Handler
import android.os.Looper

/**
 * Where a localized body puts the session count. JavaScript renders the
 * translated sentence once with this token in place of the number, and the
 * native side substitutes the registry's own count, so the text never depends
 * on a number the destroyed runtime once reported.
 */
internal const val COUNT_TOKEN = "{count}"

internal data class SessionTexts(
  val channelName: String,
  val title: String,
  val bodyTemplate: String,
  val disconnectAllLabel: String,
)

/**
 * The background notification and the service lifecycle, driven by the native
 * registry rather than by a count JavaScript reports.
 *
 * The registry is the only owner of the open sessions, so the number in the
 * notification is read from it on every sync: a JavaScript reload can neither
 * inflate nor zero the count, a session that dies while no runtime is attached
 * still drops out of the text, and the foreground service stops exactly when
 * the last native session goes away.
 */
internal object BackgroundSessions {
  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile var texts = SessionTexts("SSH sessions", "SSH session active", "", "Disconnect all")
    private set

  private var serviceRunning = false

  /** Invoked from the notification action; set once the registry is up. */
  var disconnectAll: (() -> Unit)? = null

  /** The localized body with the live session count in it. */
  fun body(): String = texts.bodyTemplate.replace(COUNT_TOKEN, SshRegistry.sessionCount().toString())

  fun configure(
    context: Context,
    channelName: String,
    title: String,
    disconnectAllLabel: String,
  ): Int {
    texts = texts.copy(
      channelName = channelName,
      title = title,
      disconnectAllLabel = disconnectAllLabel,
    )
    sync(context)

    return SshRegistry.sessionCount()
  }

  fun setBody(context: Context, template: String) {
    texts = texts.copy(bodyTemplate = template)
    refresh(context)
  }

  fun sync(context: Context) {
    val count = SshRegistry.sessionCount()
    val opened = !serviceRunning && count > 0
    val closed = serviceRunning && count == 0
    serviceRunning = count > 0

    when {
      opened -> mainHandler.post { SshSessionService.start(context) }
      closed -> mainHandler.post { SshSessionService.stop(context) }
      else -> refresh(context)
    }
  }

  private fun refresh(context: Context) {
    mainHandler.post { if (serviceRunning) SessionNotifications.postOngoing(context) }
  }
}