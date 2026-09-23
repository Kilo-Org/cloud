package com.kilocode.activeagentsliveupdate

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.util.Log
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher

/**
 * Local Expo module for the Android aggregate ongoing notification.
 *
 * The JS side owns the translated copy, the deep link, the kind's channel (and
 * its creation), the alert decision, and the revision guard; this module owns
 * the fixed notification id, the posted-channel mirror, the API 36.1+ promotion
 * gate, and the content intent plus named actions: Open deep-links into the
 * recorded session (the Agents tab when nothing waits), and Approve runs the
 * headless approval when a cloud-agent permission waits. Both platforms answer
 * through `src/lib/glanceable/approve-ask.ts`.
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

    // Group the Open label and URL so both entry points fit Expo's eight-argument
    // Function limit while preserving the action and notification-kind fields.
    //
    // `start`, `update` and `end` are the durable writes whose state the JS side
    // never reads back in the same turn: their bodies commit to SharedPreferences
    // (a synchronous fsync), arm or cancel the OS alarm, and post the
    // notification, so they run on the module queue rather than the JavaScript
    // thread. The JS bridge (`src/glanceable-android/live-update.ts`) declares
    // them `void` and never consumes the promise, which is why `durable` logs a
    // failure instead of letting it become an unhandled rejection.
    AsyncFunction("start") { title: String, text: String, openAction: Map<String, String>, approveLabel: String?, compactText: String?, channelId: String, alerting: Boolean, promotion: Boolean ->
      durable {
        post(title, text, openAction.getValue("label"), openAction.getValue("url"), approveLabel, compactText, channelId, alerting, promotion, 0)
      }
    }.runOnQueue(moduleQueue)

    // Expo's `Function` builder has one overload per arity and stops at eight
    // arguments (expo-modules-core `ObjectDefinitionBuilder`), so `update`
    // cannot carry `start`'s `promotion` flag on top of the terminal
    // `timeoutMs`. The flag is redundant on this path: `post` gates promotion
    // on `isPromotionCapable()` itself, which is the value the JS side passed.
    AsyncFunction("update") { title: String, text: String, openAction: Map<String, String>, approveLabel: String?, compactText: String?, channelId: String, alerting: Boolean, timeoutMs: Double ->
      durable {
        post(title, text, openAction.getValue("label"), openAction.getValue("url"), approveLabel, compactText, channelId, alerting, isPromotionCapable(), timeoutMs.toLong())
      }
    }.runOnQueue(moduleQueue)

    AsyncFunction("end") {
      durable {
        dismiss()
      }
    }.runOnQueue(moduleQueue)

    // `setWidgetSnapshot` is the one durable write the JS side reads back in the
    // same turn: an in-place widget action republishes the snapshot through the
    // sink and `register.ts`'s `handleWidgetAction` redraws immediately, whose
    // `currentProps()` re-reads native storage (`register.ts:176-189`). The read
    // must see this write, so the entry point stays a synchronous `Function`: it
    // records the snapshot on the JS thread and hands only the durable body —
    // the prefs fsync and the `AlarmManager` round-trip — to the module queue.
    Function("setWidgetSnapshot") { snapshot: String, expiresAt: Double ->
      widgetSnapshot = snapshot
      executor.execute {
        durable {
          ActiveAgentsDeadlineReceiver.setWidgetSnapshot(context, snapshot, expiresAt.toLong())
        }
      }
    }

    // This read stays a synchronous `Function` too: its Promise form would change
    // the JS bridge and its consumers (`live-update.ts`, `register.ts`,
    // `android-sink.ts`), which this module does not own. It answers with the
    // snapshot this runtime last handed to `setWidgetSnapshot` — so the redraw
    // after a successful in-place action never reads the pre-action snapshot the
    // still-queued commit has not replaced — and falls back to the persisted
    // snapshot only for a runtime that has written none (a fresh process), which
    // is exactly what the old synchronous body returned.
    Function("getWidgetSnapshot") {
      widgetSnapshot ?: ActiveAgentsDeadlineReceiver.getWidgetSnapshot(context)
    }

    // The channel the posted card carries, or null when the module has posted
    // nothing. The JS side reads this after a process restart to tell a card
    // still in the shade from a widget snapshot that was stored without a post.
    Function("getPostedChannel") {
      postedChannelOrNull()
    }

    OnDestroy {
      // The single queue thread must not outlive the module: a reload would
      // otherwise leak one executor thread per module instance.
      executor.shutdown()
    }
  }

  /**
   * The module's one serial queue for the durable write path.
   *
   * The JS thread must not pay the prefs fsync and binder round-trips these
   * writes make, and neither default queue fits: `Queues.DEFAULT` is a thread
   * pool (the writes would race each other and the order `post` depends on
   * would not hold) and `Queues.MAIN` would put the fsync on the UI thread. A
   * single-thread executor wrapped as a scope is what `runOnQueue` accepts for
   * a custom queue.
   *
   * The queue is Android's alone, like the SharedPreferences fsync and the
   * `AlarmManager` round-trip it carries: iOS's counterpart card is the
   * ActivityKit Live Activity driven from `src/glanceable-ios/ios-sink.ts`,
   * whose snapshot is persisted in JS, so that side has no synchronous native
   * write to move off the JS thread.
   */
  private val executor = Executors.newSingleThreadExecutor { Thread(it, "active-agents-live-update") }
  private val moduleQueue = CoroutineScope(executor.asCoroutineDispatcher())

  /**
   * The snapshot this JS runtime most recently handed to `setWidgetSnapshot`, or
   * null when it has written none. The durable commit runs on the module queue,
   * so a read in the same turn as the write would otherwise see the previous
   * snapshot; this record is what lets `getWidgetSnapshot` answer with the value
   * the JS side just issued. A fresh runtime starts null and falls back to the
   * persisted snapshot. Both the assignment and the read happen on the JS
   * thread, so no synchronization is needed.
   */
  private var widgetSnapshot: String? = null

  /**
   * Run one durable write on the module queue and log a failure instead of
   * throwing it. The JS bridge declares these entry points `void` and never
   * consumes the promise an `AsyncFunction` returns, so a thrown error would
   * surface only as an unhandled promise rejection nobody can catch. The
   * durable bodies keep their `check(...)` guards and their exact order; this
   * only decides where the failure is reported.
   */
  private fun durable(block: () -> Unit) {
    try {
      block()
    } catch (error: Throwable) {
      Log.e(TAG, "Active agents live update failed", error)
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

  /**
   * A PendingIntent that deep-links the app to the URL the JS side named: the
   * waiting session's route when one is recorded, the Agents tab otherwise.
   *
   * `PendingIntent.getActivity` matches on `Intent.filterEquals`, which includes
   * the data URI, so a per-session URL would leave the previous session's record
   * behind under the fixed request code instead of updating it, and the OS would
   * accumulate one Open record per session. `commitOpenUrl` retires the
   * superseded record once the post that carries this one lands, so the app
   * holds one Open record at a time and a post that throws leaves the card still
   * in the shade with the record it already carries.
   */
  private fun openPendingIntent(openUrl: String): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(openUrl)).apply {
      setPackage(context.packageName)
    }
    return PendingIntent.getActivity(
      context,
      OPEN_REQUEST_CODE,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  /**
   * Drop the PendingIntent record a superseded Open URL created. `FLAG_NO_CREATE`
   * returns the existing record only, so a URL whose record is already gone is a
   * no-op rather than a new record.
   */
  private fun cancelOpenIntent(openUrl: String) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(openUrl)).apply {
      setPackage(context.packageName)
    }
    PendingIntent.getActivity(
      context,
      OPEN_REQUEST_CODE,
      intent,
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
    )?.cancel()
  }

  /**
   * Retire the Open record the superseded URL created and remember the URL now
   * in the shade. Called only after the post lands: the card still on screen
   * after a failed post carries the previous record, so cancelling it before the
   * post succeeds would leave that card unservable.
   */
  private fun commitOpenUrl(previousUrl: String?, openUrl: String) {
    if (previousUrl == openUrl) {
      return
    }
    if (previousUrl != null) {
      cancelOpenIntent(previousUrl)
    }
    check(notificationState.edit().putString(OPEN_URL, openUrl).commit()) {
      "Cannot persist the active agents open URL"
    }
  }

  /**
   * The Approve action: one broadcast the receiver turns into a unique answer,
   * with no Activity. The phone can be locked when the surface answers, and the
   * approval needs no screen.
   */
  private fun approvePendingIntent(): PendingIntent {
    val intent = Intent(context, ActiveAgentsActionReceiver::class.java)
      .setAction(ActiveAgentsActionReceiver.ACTION_APPROVE)
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
    openLabel: String,
    openUrl: String,
    approveLabel: String?,
    compactText: String?,
    channelId: String,
    alerting: Boolean,
    promotion: Boolean,
    timeoutMs: Long
  ) {
    // Read the URL the shade card carries before this call can change it: a
    // failed post must leave `OPEN_URL` naming the previous card's record.
    val previousOpenUrl = notificationState.getString(OPEN_URL, null)
    val contentIntent = openPendingIntent(openUrl)
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
          openLabel,
          contentIntent
        ).build()
      )

    // No recorded approvable ask: the action is omitted, not disabled. The JS
    // side drops the label once the wait is answered elsewhere.
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
      // The post did not land. The Open record this call created is
      // unreferenced: any card still in the shade carries the previous record,
      // which `openPendingIntent` left intact, so drop the new record and keep
      // `OPEN_URL` naming the previous card's.
      if (previousOpenUrl != openUrl) {
        cancelOpenIntent(openUrl)
      }
      // When this call removed the previous card the shade holds nothing, so
      // drop the marker before rethrowing a later start does not adopt a kind
      // from a card that is not there. A same-channel update removed nothing:
      // its previous card is still posted, so clearing the marker would strand
      // it on the next channel switch and hide it from a JS restart's adoption.
      // Restore the timeout flag with the marker.
      if (previousChannelId != channelId || clearsOnTimeoutChange) {
        notificationState.edit().remove(POSTED_CHANNEL).remove(HAS_TIMEOUT).apply()
      } else {
        notificationState.edit().putBoolean(HAS_TIMEOUT, previousHasTimeout).apply()
      }
      throw error
    }
    // The post landed: retire the superseded Open record and remember the new
    // URL, so the card in the shade and `OPEN_URL` describe the same record.
    commitOpenUrl(previousOpenUrl, openUrl)
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
    // The card's Open record outlives the notification unless it is cancelled
    // here; the fixed id stays, so the next post creates a new one.
    notificationState.getString(OPEN_URL, null)?.let { cancelOpenIntent(it) }
    notificationState.edit().remove(HAS_TIMEOUT).remove(POSTED_CHANNEL).remove(OPEN_URL).apply()
  }

  private companion object {
    const val TAG = "ActiveAgentsLiveUpdate"
    const val HAS_TIMEOUT = "has_timeout"
    const val OPEN_REQUEST_CODE = 1002
    const val OPEN_URL = "open_url"
    const val POSTED_CHANNEL = "posted_channel"

    /** The kind marker in the channel id the JS side creates for needs-input. */
    const val NEEDS_INPUT_CHANNEL_ID = "needs-input"
    const val APPROVE_REQUEST_CODE = 1003
  }
}
