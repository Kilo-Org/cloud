package com.kilocode.activeagentsliveupdate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
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

    Function("start") { title: String, text: String, promotion: Boolean ->
      post(title, text, promotion)
    }

    Function("update") { title: String, text: String, promotion: Boolean ->
      post(title, text, promotion)
    }

    Function("end") {
      dismiss()
    }
  }

  private val context: Context
    get() = appContext.reactContext ?: appContext.applicationContext

  private val notificationManager: NotificationManager
    get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun smallIconId(): Int =
    context.resources.getIdentifier("notification_icon", "drawable", context.packageName)

  private fun isPromotionCapable(): Boolean =
    Build.VERSION.SDK_INT_FULL >= 36_001_000 && notificationManager.canPostPromotedNotifications()

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

  private fun post(title: String, text: String, promotion: Boolean) {
    val builder = newBuilder(title)
      .setSmallIcon(smallIconId())
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSound(null)
      .setCategory(Notification.CATEGORY_STATUS)

    // API 36.1+ Live Update: promote only when the device reports the capability.
    // setRequestPromotedOngoing does not exist; use the documented flag setter.
    if (promotion && isPromotionCapable()) {
      builder.setFlag(Notification.FLAG_PROMOTED_ONGOING, true)
      builder.setStyle(Notification.ProgressStyle())
    }

    notificationManager.notify(NOTIFICATION_ID, builder.build())
  }

  private fun dismiss() {
    notificationManager.cancel(NOTIFICATION_ID)
  }

  private companion object {
    const val CHANNEL_ID = "active-agents"
    const val NOTIFICATION_ID = 1001
  }
}