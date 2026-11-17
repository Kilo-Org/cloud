package com.kilocode.activeagentsliveupdate

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.graphics.drawable.Icon
import android.os.Build

/**
 * The one home of the two record builders both Android cards share.
 *
 * The aggregate card and every followed-session card ask for their record the
 * same way, so the API 26 channel fork and the action record are written once. A
 * correction to the legacy branch, or a change to how an action carries its
 * icon, then lands in one place. What differs per surface keeps its own file:
 * the group, the category, the palette, the timeout, the promotion request and
 * the action labels.
 */
internal object CardBuilders {
  /**
   * A builder for a card on `channelId`. Notification channels exist from API 26.
   * Below it the platform has no channel, and the one-argument builder is the
   * only form that accepts a card there, so API 24-25 keep their card without a
   * channel.
   */
  fun builder(context: Context, channelId: String): Notification.Builder =
    if (Build.VERSION.SDK_INT >= 26) {
      Notification.Builder(context, channelId)
    } else {
      legacyBuilder(context)
    }

  /** The deprecated one-argument form: API 24-25 has no channel to name. */
  @Suppress("DEPRECATION")
  private fun legacyBuilder(context: Context): Notification.Builder = Notification.Builder(context)

  /** One action of a card, with the app drawable as its icon. */
  fun action(
    context: Context,
    icon: Int,
    label: String,
    intent: PendingIntent,
    authenticationRequired: Boolean = false
  ): Notification.Action =
    Notification.Action.Builder(Icon.createWithResource(context, icon), label, intent)
      .apply {
        if (authenticationRequired && Build.VERSION.SDK_INT >= 31) {
          setAuthenticationRequired(true)
        }
      }
      .build()
}
