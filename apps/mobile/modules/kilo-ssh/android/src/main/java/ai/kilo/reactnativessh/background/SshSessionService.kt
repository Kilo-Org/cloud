package ai.kilo.reactnativessh.background

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat

/**
 * Keeps the process in a `specialUse` foreground state while SSH sessions are
 * open, so their sockets and the React Native runtime survive the app leaving
 * the screen.
 */
class SshSessionService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_DISCONNECT_ALL) {
      BackgroundSessions.disconnectAll?.invoke()
      stopSelf()

      return START_NOT_STICKY
    }

    startInForeground()

    return START_NOT_STICKY
  }

  private fun startInForeground() {
    val notification = SessionNotifications.ongoing(this)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(
        SessionNotifications.ONGOING_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
      )
    } else {
      startForeground(SessionNotifications.ONGOING_ID, notification)
    }
  }

  companion object {
    const val ACTION_DISCONNECT_ALL = "ai.kilo.reactnativessh.DISCONNECT_ALL"

    fun start(context: Context): Boolean = try {
      ContextCompat.startForegroundService(context, Intent(context, SshSessionService::class.java))
      true
    } catch (_: IllegalStateException) {
      // Android 8+ refuses a background service start and 12+ throws
      // ForegroundServiceStartNotAllowedException here: the caller waits for
      // the app to come back instead of taking the process down.
      false
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, SshSessionService::class.java))
    }
  }
}
