package com.kilocode.activeagentsliveupdate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Local Expo module for the Android aggregate ongoing notification.
 *
 * The JS side owns the translated copy and the revision guard; this module owns
 * the fixed notification id, the dedicated `active-agents` channel (default
 * importance, silent, no heads-up), and the API 36.1+ promotion gate.
 */
class ActiveAgentsLiveUpdateModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ActiveAgentsLiveUpdate")

    Function("isPromotionCapable") {
      isPromotionCapable()
    }

    Function("start") { title: String, text: String, compactText: String?, promotion: Boolean ->
      post(title, text, compactText, promotion, 0)
    }

    Function("update") { title: String, text: String, compactText: String?, promotion: Boolean, timeoutMs: Double ->
      post(title, text, compactText, promotion, timeoutMs.toLong())
    }

    Function("end") {
      dismiss()
    }

    Function("setWidgetSnapshot") { snapshot: String, expiresAt: Double ->
      ActiveAgentsDeadlineReceiver.setWidgetSnapshot(context, snapshot, expiresAt.toLong())
    }

    Function("getWidgetSnapshot") {
      ActiveAgentsDeadlineReceiver.getWidgetSnapshot(context)
    }
  }

  private val context: Context
    get() = appContext.reactContext ?: appContext.applicationContext

  private val notificationManager: NotificationManager
    get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private val notificationState
    get() = context.getSharedPreferences("active_agents_notification", Context.MODE_PRIVATE)

  private fun smallIconId(): Int =
    context.resources.getIdentifier("notification_icon", "drawable", context.packageName)

  private fun isPromotionCapable(): Boolean =
    Build.VERSION.SDK_INT >= 36 &&
      Build.VERSION.SDK_INT_FULL >= 36_001_000 &&
      notificationManager.canPostPromotedNotifications()

  private fun ensureChannel(title: String) {
    if (Build.VERSION.SDK_INT < 26) {
      return
    }
    if (notificationManager.getNotificationChannel(CHANNEL_ID) != null) {
      return
    }
    val channel = NotificationChannel(CHANNEL_ID, title, NotificationManager.IMPORTANCE_DEFAULT)
    channel.setSound(null, null)
    channel.enableVibration(false)
    channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    notificationManager.createNotificationChannel(channel)
  }

  private fun newBuilder(title: String): Notification.Builder {
    if (Build.VERSION.SDK_INT >= 26) {
      ensureChannel(title)
      return Notification.Builder(context, CHANNEL_ID)
    }
    return legacyBuilder()
  }

  @Suppress("DEPRECATION")
  private fun legacyBuilder(): Notification.Builder = Notification.Builder(context)

  /** A PendingIntent that deep-links the app to the Open agents route. */
  private fun openAgentsPendingIntent(): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(OPEN_AGENTS_DEEP_LINK)).apply {
      setPackage(context.packageName)
    }
    return PendingIntent.getActivity(
      context,
      OPEN_AGENTS_REQUEST_CODE,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun post(title: String, text: String, compactText: String?, promotion: Boolean, timeoutMs: Long) {
    val builder = newBuilder(title)
      .setSmallIcon(smallIconId())
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(openAgentsPendingIntent())
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSound(null)
      .setCategory(Notification.CATEGORY_STATUS)

    // API 36.1+ Live Update: promote only when the device reports the capability.
    // setRequestPromotedOngoing does not exist; use the documented flag setter.
    if (promotion && isPromotionCapable()) {
      builder.setFlag(Notification.FLAG_PROMOTED_ONGOING, true)
      builder.setShortCriticalText(compactText)
      builder.setStyle(Notification.ProgressStyle())
    }

    // Commit before arming a timeout so process exit cannot lose cancellation state.
    if (timeoutMs > 0) {
      check(notificationState.edit().putBoolean(HAS_TIMEOUT, true).commit()) {
        "Cannot persist the active agents notification timeout"
      }
    }

    if (Build.VERSION.SDK_INT >= 26) {
      // Ordinary updates must retain the notification so onlyAlertOnce suppresses repeat alerts.
      if (timeoutMs <= 0 && notificationState.getBoolean(HAS_TIMEOUT, false)) {
        notificationManager.cancel(ActiveAgentsDeadlineReceiver.NOTIFICATION_ID)
      }
      builder.setTimeoutAfter(timeoutMs.coerceAtLeast(0))
    } else {
      ActiveAgentsDeadlineReceiver.setLegacyNotificationTimeout(context, timeoutMs)
    }
    notificationManager.notify(ActiveAgentsDeadlineReceiver.NOTIFICATION_ID, builder.build())
    if (timeoutMs <= 0) {
      notificationState.edit().putBoolean(HAS_TIMEOUT, false).apply()
    }
  }

  private fun dismiss() {
    if (Build.VERSION.SDK_INT < 26) {
      ActiveAgentsDeadlineReceiver.setLegacyNotificationTimeout(context, 0)
    }
    notificationManager.cancel(ActiveAgentsDeadlineReceiver.NOTIFICATION_ID)
    notificationState.edit().remove(HAS_TIMEOUT).apply()
  }

  private companion object {
    const val HAS_TIMEOUT = "has_timeout"
    const val CHANNEL_ID = "active-agents"
    const val OPEN_AGENTS_DEEP_LINK = "kiloapp:///cloud/sessions"
    const val OPEN_AGENTS_REQUEST_CODE = 1002
  }
}
