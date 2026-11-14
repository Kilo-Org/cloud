package com.kilocode.activeagentsliveupdate

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.Bundle

/**
 * The one home of the API 36.1+ promoted-ongoing Live Update.
 *
 * Both Android cards ask the same question and make the same request here, so a
 * platform change lands in one place and the aggregate card and the session
 * card cannot promote differently on the same device.
 *
 * [request] carries the one request form this module means. The platform grants
 * a promotion only from the `android.requestPromotedOngoing` extra, which
 * `Notification.Builder.setRequestPromotedOngoing` writes; that setter is API
 * 36.1 and this compile SDK has no constant for it, so the extra goes in as the
 * documented string. `Notification.FLAG_PROMOTED_ONGOING` is not a request:
 * applications cannot set it, and `NotificationManagerService.fixNotification`
 * clears it from every posted notification before it decides.
 */
internal object PromotionGate {
  /**
   * The extra `Notification.Builder.setRequestPromotedOngoing` writes, kept as a
   * literal because the compile SDK predates that setter.
   */
  private const val EXTRA_REQUEST_PROMOTED_ONGOING = "android.requestPromotedOngoing"

  /**
   * The device can post a promoted card: Android 16 or later, the 16.1 feature
   * level, and the user's Live Updates setting. `canPostPromotedNotifications`
   * also preflights the `POST_PROMOTED_NOTIFICATIONS` permission, so a build
   * that does not hold it reads as incapable and the card falls back.
   */
  fun capable(context: Context): Boolean =
    Build.VERSION.SDK_INT >= 36 &&
      Build.VERSION.SDK_INT_FULL >= 36_001_000 &&
      manager(context).canPostPromotedNotifications()

  /**
   * Request the promotion on `builder` when the device is capable, and answer
   * whether it did. The caller keeps its fallback on a false answer: the session
   * card draws its expanded-only line there, and the aggregate card draws its
   * ordinary card.
   */
  fun request(
    context: Context,
    builder: Notification.Builder,
    compactText: CharSequence?
  ): Boolean {
    if (!capable(context)) {
      return false
    }
    builder.addExtras(Bundle().apply { putBoolean(EXTRA_REQUEST_PROMOTED_ONGOING, true) })
    builder.setStyle(Notification.ProgressStyle())
    if (compactText != null) {
      builder.setShortCriticalText(compactText)
    }
    return true
  }

  private fun manager(context: Context): NotificationManager =
    context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
}
