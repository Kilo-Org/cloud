package com.kilocode.activeagentsliveupdate

import android.app.Notification
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
 * The JS side owns the translated copy, the notification kind's channel (and
 * its creation), the alert decision, and the revision guard; this module owns
 * the fixed notification id, the posted-channel mirror, the API 36.1+ promotion
 * gate, and the content intent plus named actions: one that opens the Agents tab
 * via a deep link, and one that runs the headless approval when a permission
 * waits.
 *
 * This is the Android mechanism for the one shared kind model, not a second
 * behaviour: `@kilocode/notifications` maps each agent surface to `needs-input`
 * or `progress`, the JS side passes the resulting channel and alert decision
 * here, and `src/glanceable-ios/ios-sink.ts` renders the same ongoing card as an
 * ActivityKit Live Activity on the same model. The forks are the capabilities
 * Android has and iOS does not, each named where it is used: an ongoing
 * notification in the shade, with its channel and per-channel Do Not Disturb
 * override; the read of that posted notification behind `getPostedChannel`
 * (iOS's card is not a notification, so its posted read is ActivityKit's
 * `getInstances()`); and the API 36.1+ promoted-ongoing Live Update. The one
 * user-visible difference that follows is the mechanism itself — the Android
 * card alerts when it first becomes needs-input, while a Live Activity never
 * alerts, so on iOS that breakthrough is the needs-input push's
 * `time-sensitive` level plus the per-Focus filter.
 */
class ActiveAgentsLiveUpdateModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ActiveAgentsLiveUpdate")

    Function("isPromotionCapable") {
      isPromotionCapable()
    }

    // The framework applies the Do Not Disturb access gate when a channel is
    // created and ignores later app writes to a channel's override, so the JS
    // side can only tell whether the user's grant still stands by asking here.
    Function("isDndAccessGranted") {
      notificationManager.isNotificationPolicyAccessGranted
    }

    Function("start") { title: String, text: String, openAgentsLabel: String, approveLabel: String?, compactText: String?, channelId: String, alerting: Boolean, promotion: Boolean ->
      post(title, text, openAgentsLabel, approveLabel, compactText, channelId, alerting, promotion, 0)
    }

    // Expo's `Function` builder has one overload per arity and stops at eight
    // arguments (expo-modules-core `ObjectDefinitionBuilder`), so `update`
    // cannot carry `start`'s `promotion` flag on top of the terminal
    // `timeoutMs`. The flag is redundant on this path: `post` gates promotion
    // on `isPromotionCapable()` itself, which is the value the JS side passed.
    Function("update") { title: String, text: String, openAgentsLabel: String, approveLabel: String?, compactText: String?, channelId: String, alerting: Boolean, timeoutMs: Double ->
      post(title, text, openAgentsLabel, approveLabel, compactText, channelId, alerting, isPromotionCapable(), timeoutMs.toLong())
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

    // The channel the posted card carries, or null when the module has posted
    // nothing. The JS side reads this after a process restart to tell a card
    // still in the shade from a widget snapshot that was stored without a post.
    Function("getPostedChannel") {
      postedChannelOrNull()
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

  /**
   * The channel the module last posted, or null when it has posted nothing.
   *
   * The card changes channel when its kind changes, and the framework drops a
   * post addressed to a channel the user disabled instead of moving the card,
   * so `post` needs the posted channel to clear the card first.
   *
   * The module mirrors the channel it posted in its own state instead of
   * reading the framework's copy: `Notification.channelId` only exists on API
   * 26+, and notification channels do not exist below it, so a version fork
   * would buy nothing the mirror does not already hold on every API.
   */
  private fun postedChannelId(): String? = notificationState.getString(POSTED_CHANNEL, null)

  private fun newBuilder(channelId: String): Notification.Builder {
    if (Build.VERSION.SDK_INT >= 26) {
      // The JS side creates and names every channel before the first post.
      return Notification.Builder(context, channelId)
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

  /**
   * The channel a card still in the shade carries, or null when no card is
   * posted. The stored marker alone can outlive the card: a terminal timeout
   * removes the notification without any further app call, and the marker
   * survives a process exit, so confirm the fixed id is still active before the
   * JS side adopts the kind on a restart.
   *
   * The fork here is the capability: the posted card is an Android
   * notification, and only its own `NotificationManager` can report whether it
   * is still in the shade. iOS's counterpart card is the ActivityKit Live
   * Activity, whose posted read is `ActiveAgentsLiveActivity.getInstances()` in
   * `src/glanceable-ios/ios-sink.ts`; the kind model both sides read is shared,
   * so the restart adoption exists on both platforms.
   */
  private fun postedChannelOrNull(): String? {
    val posted = postedChannelId() ?: return null
    val stillPosted = notificationManager.activeNotifications.any {
      it.id == ActiveAgentsDeadlineReceiver.NOTIFICATION_ID
    }
    return if (stillPosted) posted else null
  }

  private fun post(
    title: String,
    text: String,
    openAgentsLabel: String,
    approveLabel: String?,
    compactText: String?,
    channelId: String,
    alerting: Boolean,
    promotion: Boolean,
    timeoutMs: Long
  ) {
    val contentIntent = openAgentsPendingIntent()
    // The two OS paths a notification can interrupt Do Not Disturb with are the
    // channel's DND override (user-granted, requested by the app) and the
    // message category, which is what a notification that expects an answer
    // uses. A needs-input card takes both; a progress card keeps the status
    // category and the silent behaviour it had.
    val needsInput = channelId == NEEDS_INPUT_CHANNEL_ID
    val builder = newBuilder(channelId)
      .setSmallIcon(smallIconId())
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .setCategory(if (needsInput) Notification.CATEGORY_MESSAGE else Notification.CATEGORY_STATUS)
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

    if (needsInput) {
      // Only the first entry into the kind alerts; a later update in the same
      // kind must not re-alert.
      builder.setOnlyAlertOnce(!alerting)
    } else {
      builder.setSound(null)
      builder.setOnlyAlertOnce(true)
    }

    // API 36.1+ Live Update: promote only when the device reports the capability.
    // setRequestPromotedOngoing does not exist; use the documented flag setter.
    if (promotion && isPromotionCapable()) {
      builder.setFlag(Notification.FLAG_PROMOTED_ONGOING, true)
      builder.setShortCriticalText(compactText)
      builder.setStyle(Notification.ProgressStyle())
    }

    // Snapshot the timeout flag a failed same-channel post must restore: that
    // post leaves the previous card in the shade, so the flag must keep
    // describing it rather than the timeout this call could not arm.
    val previousHasTimeout = notificationState.getBoolean(HAS_TIMEOUT, false)

    // Commit before arming a timeout so process exit cannot lose cancellation state.
    if (timeoutMs > 0) {
      check(notificationState.edit().putBoolean(HAS_TIMEOUT, true).commit()) {
        "Cannot persist the active agents notification timeout"
      }
    }

    // The card changes channel when its kind changes, so clear the posted card
    // first: a destination channel the user disabled drops the post rather than
    // moving the card, which would leave the previous kind's card in the shade.
    // The alert decision above is unchanged, so the fresh post still alerts only
    // when the JS side asked it to.
    //
    // Each cancel is also what a failed post below needs to know: only a post
    // that removed the card it found leaves no card for the durable marker to
    // describe. A same-channel update removes nothing and keeps the previous
    // card in the shade (see the catch).
    val previousChannelId = postedChannelId()
    val clearsOnChannelSwitch = previousChannelId != null && previousChannelId != channelId
    if (clearsOnChannelSwitch) {
      notificationManager.cancel(ActiveAgentsDeadlineReceiver.NOTIFICATION_ID)
    }

    // Ordinary updates must retain the notification so onlyAlertOnce suppresses repeat alerts.
    val clearsOnTimeoutChange = Build.VERSION.SDK_INT >= 26 && timeoutMs <= 0 && previousHasTimeout
    if (clearsOnTimeoutChange) {
      notificationManager.cancel(ActiveAgentsDeadlineReceiver.NOTIFICATION_ID)
    }
    if (Build.VERSION.SDK_INT >= 26) {
      builder.setTimeoutAfter(timeoutMs.coerceAtLeast(0))
    } else {
      ActiveAgentsDeadlineReceiver.setLegacyNotificationTimeout(context, timeoutMs)
    }
    try {
      notificationManager.notify(ActiveAgentsDeadlineReceiver.NOTIFICATION_ID, builder.build())
    } catch (error: Throwable) {
      // The post did not land. When this call removed the previous card the
      // shade holds nothing, so drop the marker before rethrowing a later start
      // does not adopt a kind from a card that is not there. A same-channel
      // update removed nothing: its previous card is still posted, so clearing
      // the marker would strand it on the next channel switch and hide it from a
      // JS restart's adoption. Restore the timeout flag with the marker.
      if (previousChannelId != channelId || clearsOnTimeoutChange) {
        notificationState.edit().remove(POSTED_CHANNEL).remove(HAS_TIMEOUT).apply()
      } else {
        notificationState.edit().putBoolean(HAS_TIMEOUT, previousHasTimeout).apply()
      }
      throw error
    }
    // Mirror the posted channel so the next post can tell whether the card moves.
    // Commit, like the timeout flag: the shade card survives a process exit, so
    // the mirror that describes it must too.
    val state = notificationState.edit().putString(POSTED_CHANNEL, channelId)
    if (timeoutMs <= 0) {
      state.putBoolean(HAS_TIMEOUT, false)
    }
    check(state.commit()) { "Cannot persist the active agents notification channel" }
  }

  private fun dismiss() {
    if (Build.VERSION.SDK_INT < 26) {
      ActiveAgentsDeadlineReceiver.setLegacyNotificationTimeout(context, 0)
    }
    notificationManager.cancel(ActiveAgentsDeadlineReceiver.NOTIFICATION_ID)
    notificationState.edit().remove(HAS_TIMEOUT).remove(POSTED_CHANNEL).apply()
  }

  private companion object {
    const val HAS_TIMEOUT = "has_timeout"
    const val POSTED_CHANNEL = "posted_channel"

    /** The kind marker in the channel id the JS side creates for needs-input. */
    const val NEEDS_INPUT_CHANNEL_ID = "needs-input"
    const val OPEN_AGENTS_DEEP_LINK = "kiloapp:///cloud/sessions"
    const val OPEN_AGENTS_REQUEST_CODE = 1002
    const val ACTION_APPROVE = "com.kilocode.activeagentsliveupdate.action.APPROVE"
    const val APPROVE_REQUEST_CODE = 1003
  }
}
