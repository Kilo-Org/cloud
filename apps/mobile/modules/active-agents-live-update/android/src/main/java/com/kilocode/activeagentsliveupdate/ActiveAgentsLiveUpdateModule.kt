package com.kilocode.activeagentsliveupdate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Local Expo module for the Android aggregate ongoing notification.
 *
 * The JS side owns the translated copy and the revision guard; this module owns
 * the fixed notification id, the dedicated `active-agents` channel (default
 * importance, silent, no heads-up), the API 36.1+ promotion gate, and the
 * content intent plus named actions: one that opens the Agents tab via a deep
 * link, and one that runs the headless approval when a permission waits.
 */
class ActiveAgentsLiveUpdateModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ActiveAgentsLiveUpdate")

    Function("isPromotionCapable") {
      isPromotionCapable()
    }

    Function("start") { title: String, text: String, openAgentsLabel: String, approveLabel: String?, compactText: String?, promotion: Boolean ->
      post(title, text, openAgentsLabel, approveLabel, compactText, promotion, 0)
    }

    Function("update") { title: String, text: String, openAgentsLabel: String, approveLabel: String?, compactText: String?, promotion: Boolean, timeoutMs: Double ->
      post(title, text, openAgentsLabel, approveLabel, compactText, promotion, timeoutMs.toLong())
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

  // `AppContext` exposes only the React context. Every entry point here runs
  // from a JS call, so losing it means the module cannot work at all.
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

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

  /**
   * A PendingIntent that hands the tap to the headless approve task. A
   * broadcast, not an Activity: the phone can be locked when the Wear OS
   * surface answers, and the approval needs no screen.
   */
  private fun approvePendingIntent(): PendingIntent {
    val intent = Intent(context, ActiveAgentsApproveReceiver::class.java)
      .setAction(ACTION_APPROVE)
    return PendingIntent.getBroadcast(
      context,
      APPROVE_REQUEST_CODE,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun post(
    title: String,
    text: String,
    openAgentsLabel: String,
    approveLabel: String?,
    compactText: String?,
    promotion: Boolean,
    timeoutMs: Long
  ) {
    val contentIntent = openAgentsPendingIntent()
    val builder = newBuilder(title)
      .setSmallIcon(smallIconId())
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSound(null)
      .setCategory(Notification.CATEGORY_STATUS)
      .addAction(
        Notification.Action.Builder(
          Icon.createWithResource(context, smallIconId()),
          openAgentsLabel,
          contentIntent
        ).build()
      )

    // The second action is the wrist control: it appears exactly while a
    // session waits on a permission, and the JS side drops the label when the
    // wait is answered.
    if (approveLabel != null) {
      builder.addAction(
        Notification.Action.Builder(
          Icon.createWithResource(context, smallIconId()),
          approveLabel,
          approvePendingIntent()
        ).build()
      )
    }

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
    const val ACTION_APPROVE = "com.kilocode.activeagentsliveupdate.action.APPROVE"
    const val APPROVE_REQUEST_CODE = 1003
  }
}
