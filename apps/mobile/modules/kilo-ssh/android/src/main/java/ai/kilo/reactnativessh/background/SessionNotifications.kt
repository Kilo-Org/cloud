package ai.kilo.reactnativessh.background

import ai.kilo.reactnativessh.R
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * Builds the two notifications the background sessions own: the ongoing one the
 * foreground service is tied to, and the one a finished command posts.
 */
internal object SessionNotifications {
  private const val CHANNEL_ID = "ssh-sessions"
  const val ONGOING_ID = 4101
  private const val IDLE_ID_BASE = 4200

  fun ongoing(context: Context): Notification {
    ensureChannel(context)

    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_ssh_session)
      .setContentTitle(BackgroundSessions.texts.title)
      .setContentText(BackgroundSessions.body())
      .setOngoing(true)
      .setSilent(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .addAction(0, BackgroundSessions.texts.disconnectAllLabel, disconnectAll(context))

    launch(context)?.let(builder::setContentIntent)

    return builder.build()
  }

  fun postOngoing(context: Context) {
    manager(context).notify(ONGOING_ID, ongoing(context))
  }

  fun postIdle(context: Context, shellId: String, title: String, body: String?) {
    ensureChannel(context)

    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_ssh_session)
      .setContentTitle(title)
      .setContentText(body)
      .setAutoCancel(true)

    launch(context)?.let(builder::setContentIntent)

    manager(context).notify(IDLE_ID_BASE + (shellId.hashCode() and 0xFF), builder.build())
  }

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }

    val channel = NotificationChannel(
      CHANNEL_ID,
      BackgroundSessions.texts.channelName,
      NotificationManager.IMPORTANCE_DEFAULT,
    )

    manager(context).createNotificationChannel(channel)
  }

  private fun launch(context: Context): PendingIntent? {
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null

    return PendingIntent.getActivity(
      context,
      0,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  private fun disconnectAll(context: Context): PendingIntent =
    PendingIntent.getService(
      context,
      1,
      Intent(context, SshSessionService::class.java).setAction(SshSessionService.ACTION_DISCONNECT_ALL),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

  private fun manager(context: Context): NotificationManager =
    requireNotNull(context.getSystemService(NotificationManager::class.java)) { "no notification manager" }
}
