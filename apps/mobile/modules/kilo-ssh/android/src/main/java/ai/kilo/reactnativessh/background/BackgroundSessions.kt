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
 *
 * `sync` arrives from the module's coroutines and from the core's disconnect
 * callback, so the count, the transition it implies and the queued action all
 * fall under one lock: two interleaved transitions would otherwise post a stop
 * for a start that had not been posted yet.
 */
internal object BackgroundSessions {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val lock = Any()

  @Volatile var texts = SessionTexts("SSH sessions", "SSH session active", "", "Disconnect all")
    private set

  @Volatile private var serviceRunning = false
  private var startDeferred = false

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
    synchronized(lock) {
      val count = SshRegistry.sessionCount()
      val opened = !serviceRunning && count > 0
      val closed = serviceRunning && count == 0
      serviceRunning = count > 0
      if (closed) startDeferred = false

      val action = when {
        opened -> Runnable { start(context) }
        closed -> Runnable { SshSessionService.stop(context) }
        else -> null
      }
      if (action == null) refresh(context) else mainHandler.post(action)
    }
  }

  private fun start(context: Context) {
    if (SshRegistry.sessionCount() == 0) {
      synchronized(lock) { serviceRunning = false }
      return
    }
    if (!isAppForeground()) {
      deferStart(context)
      return
    }

    synchronized(lock) { startDeferred = false }

    if (SshSessionService.start(context)) {
      synchronized(lock) { serviceRunning = true }
      refresh(context)
    } else {
      // The system refused a start it still considers backgrounded: nothing is
      // running, so the next sync — or the app coming back — tries again.
      synchronized(lock) { serviceRunning = false }
      deferStart(context)
    }
  }

  /**
   * Android 12+ refuses a foreground-service start from the background, so a
   * session opened there waits for the next time the app is on screen instead
   * of crashing the process. `start` degrades silently if it is still refused.
   */
  private fun deferStart(context: Context) {
    val schedule = synchronized(lock) {
      // Nothing was started, so a later sync is free to try again and no
      // notification is posted for a service that is not running.
      serviceRunning = false

      if (startDeferred) {
        false
      } else {
        startDeferred = true
        true
      }
    }

    if (!schedule) {
      return
    }

    runWhenForeground { if (SshRegistry.sessionCount() > 0) start(context) }
  }

  private fun refresh(context: Context) {
    mainHandler.post { if (serviceRunning) SessionNotifications.postOngoing(context) }
  }
}
