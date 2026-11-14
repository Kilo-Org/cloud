package ai.kilo.reactnativessh.background

import ai.kilo.reactnativessh.ShellActivity
import android.content.Context
import android.os.Handler
import android.os.Looper

private val mainHandler = Handler(Looper.getMainLooper())

/**
 * Watches shell output so a command that finishes while the app is off screen
 * raises a notification. A watch is one-shot: it fires after `quietMs` without
 * output, and drops itself without firing when the app is on screen.
 */
internal object IdleNotifications {
  private val watches = HashMap<String, Watch>()

  fun watch(
    context: Context,
    shellId: String,
    quietMs: Long,
    activity: ShellActivity,
    title: String,
    body: String?,
    onFinished: () -> Unit,
  ) {
    mainHandler.post {
      watches.remove(shellId)?.stop()
      watches[shellId] = Watch(context, shellId, quietMs, activity, title, body, onFinished, ::finish)
        .also { it.start() }
    }
  }

  fun release(shellId: String) {
    mainHandler.post { watches.remove(shellId)?.stop() }
  }

  private fun finish(watch: Watch) {
    if (watches[watch.shellId] !== watch) {
      return
    }

    watches.remove(watch.shellId)
    watch.stop()

    if (isAppForeground()) {
      return
    }

    SessionNotifications.postIdle(watch.context, watch.shellId, watch.title, watch.body)
    watch.onFinished()
  }
}

private class Watch(
  val context: Context,
  val shellId: String,
  private val quietMs: Long,
  private val activity: ShellActivity,
  val title: String,
  val body: String?,
  val onFinished: () -> Unit,
  private val onQuiet: (Watch) -> Unit,
) {
  @Volatile private var stopped = false

  private val quiet = Runnable { onQuiet(this) }
  private val onOutput: () -> Unit = {
    if (!stopped) {
      mainHandler.removeCallbacks(quiet)
      mainHandler.postDelayed(quiet, quietMs)
    }
  }

  fun start() {
    activity.addListener(onOutput)
  }

  fun stop() {
    stopped = true
    activity.removeListener(onOutput)
    mainHandler.removeCallbacks(quiet)
  }
}
