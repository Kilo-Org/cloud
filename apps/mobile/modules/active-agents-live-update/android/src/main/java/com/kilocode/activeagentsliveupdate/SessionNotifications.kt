package com.kilocode.activeagentsliveupdate

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Android ongoing notification of one followed session
 * (`.specs/mobile-session-live-activity.md` "Android").
 *
 * Android-only by capability: the same per-session card is an ActivityKit Live
 * Activity on iOS (`src/glanceable-ios/session-live-activity.tsx`), and Android
 * renders one ongoing notification per followed session instead. Both read the
 * one contract, `SessionLiveActivityContentState`; the JS side maps that content
 * to this card's system-template fields and this file owns the notification id,
 * the collapsed-versus-expanded split, the actions, and the Live Update
 * promotion.
 *
 * The notification is silent and `setOnlyAlertOnce` at all times: a followed
 * session is a glance, never a ring. A Working card counts up on the system
 * timer. Every other card hides the system time, which draws a relative age,
 * and its text names the absolute time the JS side formats.
 *
 * The module holds exactly one notification per session, keyed by a stable id
 * derived from the session id, tagged so a session can never take another
 * session's place. SharedPreferences keeps the card's facts and the scope it was
 * followed in, so a press can answer with the right organization after the
 * process was killed, and so a restart can prune the cards that are no longer in
 * the shade.
 */
internal object SessionNotifications {
  private const val STORE = "active_agents_session_notifications"
  private const val KEY_PREFIX = "session:"
  private const val CHANNEL_ID = "followed-sessions-lock-screen"

  /** The notification id of one session: stable, and never the aggregate card's. */
  private fun notificationId(sessionId: String): Int =
    SESSION_NOTIFICATION_ID_BASE + (sessionId.hashCode() and 0xFFFF)

  /** A request code unique to this session, so two cards' actions never collide. */
  private fun requestCode(sessionId: String, offset: Int): Int =
    (sessionId.hashCode() and 0xFFFF) * 4 + offset

  private fun state(context: Context) =
    context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

  /** Every followed session's stored card, as the JS side passed it. Empty when signed out. */
  fun cards(context: Context): String {
    val stored = state(context).all.filterKeys { it.startsWith(KEY_PREFIX) }
    val array = JSONArray()
    for (value in stored.values) {
      if (value is String) {
        array.put(JSONObject(value))
      }
    }
    return array.toString()
  }

  /** The session ids of the stored cards. */
  private fun storedSessionIds(context: Context): Set<String> =
    state(context).all.keys.filter { it.startsWith(KEY_PREFIX) }.map { it.removePrefix(KEY_PREFIX) }
      .toSet()

  /**
   * Cancel every stored card the JS side no longer wants and forget it. The JS
   * side calls this after a restart or a scope change, so a notification the app
   * no longer counts cannot stay in the shade.
   */
  fun prune(context: Context, keepJson: String) {
    val keep = JSONArray(keepJson).let { array -> (0 until array.length()).map(array::getString) }
    val keepSet = keep.toSet()
    for (sessionId in storedSessionIds(context)) {
      if (!keepSet.contains(sessionId)) {
        cancel(context, sessionId)
      }
    }
  }

  /** Cancel one session's notification and forget its stored card. */
  fun cancel(context: Context, sessionId: String) {
    manager(context).cancel(TAG, notificationId(sessionId))
    state(context).edit().remove(KEY_PREFIX + sessionId).apply()
    alarms(context).cancel(quietIntent(context, sessionId, 0))
  }

  /**
   * Post or update one session's notification. `card.whenMs` carries the time
   * the card shows; `card.chronometer` marks a Working card whose text is a
   * running elapsed time.
   *
   * A positive `dismissAfterMs` marks a finished card: it is no longer followed,
   * and it leaves the shade by itself after that time. It stays stored, with
   * `finishedUntil`, so a sign-out, an account change, or the privacy lock can
   * still cancel it, and a restore keeps it out of the followed set and drops it
   * once the window passes. The timeout needs API 26; on API 24-25 the restore
   * after the window is what removes it.
   */
  fun post(context: Context, card: SessionNotificationCard, dismissAfterMs: Long) {
    // One clock read for the whole post: the card drawn now and the quiet
    // alarm must agree on whether the quiet window has passed.
    val nowMs = System.currentTimeMillis()
    val timeoutMs = dismissAfterMs.coerceAtLeast(0)
    val stored = card.toJson()
    if (timeoutMs > 0) {
      stored.put(FINISHED_UNTIL, nowMs + timeoutMs)
    }
    state(context).edit().putString(KEY_PREFIX + card.sessionId, stored.toString()).commit()
    val builder = builder(context, card.shownAt(nowMs))
    if (timeoutMs > 0 && Build.VERSION.SDK_INT >= 26) {
      builder.setTimeoutAfter(timeoutMs)
    }
    manager(context).notify(TAG, notificationId(card.sessionId), builder.build())
    scheduleQuiet(context, card, nowMs)
  }

  /**
   * Arm the quiet moment of a Working card, or disarm it for every other card.
   * The alarm posts the stored card again at that moment, so the quiet warning
   * appears with no push and no running process. `nowMs` is the clock read the
   * post drew the card with.
   */
  private fun scheduleQuiet(context: Context, card: SessionNotificationCard, nowMs: Long) {
    val quietAt = card.quietAtMs.toLong()
    val operation = quietIntent(context, card.sessionId, quietAt)
    val alarmManager = alarms(context)
    alarmManager.cancel(operation)
    if (quietAt <= nowMs || card.quietText == null) {
      return
    }
    if (Build.VERSION.SDK_INT >= 31) {
      // No exact-alarm permission: Android can defer delivery while idle.
      alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, quietAt, operation)
    } else {
      alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, quietAt, operation)
    }
  }

  /**
   * The quiet alarm of one session fired. Post the stored card again only if it
   * is still the card that armed this alarm: a later update, an end, or a
   * teardown replaced or removed it, and then nothing is posted.
   */
  fun postQuiet(context: Context, sessionId: String, quietAtMs: Long) {
    val stored = state(context).getString(KEY_PREFIX + sessionId, null) ?: return
    val json = JSONObject(stored)
    if (json.has(FINISHED_UNTIL)) {
      return
    }
    val card = SessionNotificationCard().apply { fillFromJson(json) }
    if (quietAtMs <= 0 || card.quietAtMs.toLong() != quietAtMs) {
      return
    }
    post(context, card, 0)
  }

  fun restore(context: Context, sessionId: String) {
    val stored = state(context).getString(KEY_PREFIX + sessionId, null) ?: return
    val json = JSONObject(stored)
    if (json.has(FINISHED_UNTIL)) {
      return
    }
    post(context, SessionNotificationCard().apply { fillFromJson(json) }, 0)
  }

  private fun quietIntent(context: Context, sessionId: String, quietAtMs: Long): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      requestCode(sessionId, QUIET_OFFSET),
      Intent(context, ActiveAgentsActionReceiver::class.java)
        .setAction(ActiveAgentsActionReceiver.ACTION_QUIET)
        .putExtra(ActiveAgentsApproveWorker.KEY_SESSION_ID, sessionId)
        .putExtra(ActiveAgentsActionReceiver.EXTRA_QUIET_AT, quietAtMs),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

  private fun alarms(context: Context): AlarmManager =
    context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

  private fun builder(context: Context, card: SessionNotificationCard): Notification.Builder {
    val icon = smallIconId(context)
    val openIntent = PendingIntent.getActivity(
      context,
      requestCode(card.sessionId, OPEN_OFFSET),
      Intent(Intent.ACTION_VIEW, Uri.parse(card.openUrl)).setPackage(context.packageName),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val builder: Notification.Builder = if (Build.VERSION.SDK_INT >= 26) {
      Notification.Builder(context, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context)
    }
    builder
      .setSmallIcon(icon)
      .setColor(Color.parseColor(card.color))
      .setContentTitle(card.title)
      .setContentText(card.text)
      .setSubText(card.subText)
      .setContentIntent(openIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSound(null)
      .setVibrate(null)
      .setGroup("followed-session:${card.sessionId}")
      .setCategory(Notification.CATEGORY_STATUS)
      .setDeleteIntent(deleteIntent(context, card.sessionId))

    // Expanded system headers can ignore showWhen, so non-timed cards must
    // carry no timestamp at all. Their text already names the absolute time.
    if (card.chronometer) {
      builder.setUsesChronometer(true).setWhen(card.whenMs.toLong())
    } else {
      builder.setWhen(0).setShowWhen(false)
    }

    // Approve first, then Open. Approve is omitted, not disabled, when the card
    // carries no approval key.
    card.approveLabel?.let { label ->
      if (card.approvalKey != null) {
        builder.addAction(action(context, icon, label, approveIntent(context, card)))
      }
    }
    builder.addAction(action(context, icon, card.openLabel, openIntent))

    // API 36.1+ Live Update: promote only when the device reports the
    // capability. The Android 16 request is an extra, not the newer setter this
    // compile SDK does not have, and the promoted card must not be colourized.
    if (card.promotion && promotionCapable(context)) {
      builder.addExtras(android.os.Bundle().apply { putBoolean(EXTRA_REQUEST_PROMOTED_ONGOING, true) })
      if (card.chronometer) {
        builder.setChronometerCountDown(false)
      }
      builder.setStyle(Notification.ProgressStyle())
      card.compactText?.let { builder.setShortCriticalText(it) }
    } else {
      // The expanded-only line (the cost so far): the big-text style draws it
      // only when the user expands the card, so the collapsed card never shows
      // it. The promoted style has no text area for it, so a promoted card
      // leaves it out.
      card.expandedText?.let { expanded ->
        builder.setStyle(Notification.BigTextStyle().bigText("${card.text}\n$expanded"))
      }
    }
    return builder
  }

  private fun action(
    context: Context,
    icon: Int,
    label: String,
    intent: PendingIntent
  ): Notification.Action =
    Notification.Action.Builder(Icon.createWithResource(context, icon), label, intent).build()

  /** Answer the exact request this card shows. */
  private fun approveIntent(context: Context, card: SessionNotificationCard): PendingIntent {
    val approvalKey = card.approvalKey ?: return deleteIntent(context, card.sessionId)
    val intent = Intent(context, ActiveAgentsActionReceiver::class.java)
      .setAction(ActiveAgentsActionReceiver.ACTION_APPROVE)
      .putExtra(ActiveAgentsApproveWorker.KEY_SESSION_ID, card.sessionId)
      .putExtra(ActiveAgentsApproveWorker.KEY_APPROVAL_KEY, approvalKey)
      .putExtra(ActiveAgentsApproveWorker.KEY_ORGANIZATION_ID, card.organizationId)
    return PendingIntent.getBroadcast(
      context,
      requestCode(card.sessionId, APPROVE_OFFSET),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  /**
   * The dismissal the user performed: a swipe or a clear-all. The card is gone
   * from the shade either way, so the app must stop following that session; the
   * receiver turns this into the headless unfollow, which also drops the server
   * row so no later update re-posts the card.
   */
  private fun deleteIntent(context: Context, sessionId: String): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      requestCode(sessionId, DELETE_OFFSET),
      Intent(context, ActiveAgentsActionReceiver::class.java)
        .setAction(ActiveAgentsActionReceiver.ACTION_DISMISS)
        .putExtra(ActiveAgentsApproveWorker.KEY_SESSION_ID, sessionId),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

  private fun smallIconId(context: Context): Int =
    context.resources.getIdentifier("notification_icon", "drawable", context.packageName)

  private fun manager(context: Context): NotificationManager =
    context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun promotionCapable(context: Context): Boolean =
    Build.VERSION.SDK_INT >= 36 &&
      Build.VERSION.SDK_INT_FULL >= 36_001_000 &&
      manager(context).canPostPromotedNotifications()

  /** Stored beside a finished card: the epoch time its window ends. */
  private const val FINISHED_UNTIL = "finishedUntil"
  private const val TAG = "session"
  private const val SESSION_NOTIFICATION_ID_BASE = 20_000
  private const val OPEN_OFFSET = 0
  private const val APPROVE_OFFSET = 1
  private const val DELETE_OFFSET = 2
  private const val QUIET_OFFSET = 3
  private const val EXTRA_REQUEST_PROMOTED_ONGOING = "android.requestPromotedOngoing"
}

/** One followed session's notification, as the JS side maps it. */
class SessionNotificationCard : Record {
  @Field var sessionId: String = ""
  @Field var organizationId: String? = null
  @Field var title: String = ""
  @Field var text: String = ""
  @Field var subText: String? = null
  @Field var expandedText: String? = null
  @Field var compactText: String? = null
  @Field var openLabel: String = ""
  @Field var openUrl: String = ""
  @Field var approveLabel: String? = null
  @Field var approvalKey: String? = null
  @Field var whenMs: Double = 0.0
  @Field var chronometer: Boolean = false
  @Field var quietAtMs: Double = 0.0
  @Field var quietWhenMs: Double = 0.0
  @Field var quietText: String? = null
  @Field var promotion: Boolean = false
  @Field var color: String = DEFAULT_COLOR

  fun toJson(): JSONObject = JSONObject().apply {
    put("sessionId", sessionId)
    put("organizationId", organizationId ?: "")
    put("title", title)
    put("text", text)
    put("subText", subText ?: "")
    put("expandedText", expandedText ?: "")
    put("compactText", compactText ?: "")
    put("openLabel", openLabel)
    put("openUrl", openUrl)
    put("approveLabel", approveLabel ?: "")
    put("approvalKey", approvalKey ?: "")
    put("whenMs", whenMs)
    put("chronometer", chronometer)
    put("quietAtMs", quietAtMs)
    put("quietWhenMs", quietWhenMs)
    put("quietText", quietText ?: "")
    put("promotion", promotion)
    put("color", color)
  }

  /** Read the shape `toJson` writes; the readable half of the persisted pair. */
  fun fillFromJson(json: JSONObject) {
    organizationId = optionalString(json, "organizationId")
    subText = optionalString(json, "subText")
    expandedText = optionalString(json, "expandedText")
    compactText = optionalString(json, "compactText")
    approveLabel = optionalString(json, "approveLabel")
    approvalKey = optionalString(json, "approvalKey")
    sessionId = json.optString("sessionId")
    title = json.optString("title")
    text = json.optString("text")
    openLabel = json.optString("openLabel")
    openUrl = json.optString("openUrl")
    whenMs = json.optDouble("whenMs", 0.0)
    chronometer = json.optBoolean("chronometer")
    quietAtMs = json.optDouble("quietAtMs", 0.0)
    quietWhenMs = json.optDouble("quietWhenMs", 0.0)
    quietText = optionalString(json, "quietText")
    promotion = json.optBoolean("promotion")
    color = optionalString(json, "color") ?: DEFAULT_COLOR
  }

  /**
   * The card as it shows at `nowMs`. Once a Working card's quiet window has
   * passed, the text names the quiet warning and the timer counts from the
   * last activity.
   */
  fun shownAt(nowMs: Long): SessionNotificationCard {
    val quiet = quietText
    if (quietAtMs <= 0.0 || quiet == null || nowMs < quietAtMs.toLong()) {
      return this
    }
    return SessionNotificationCard().also { shown ->
      shown.fillFromJson(toJson())
      shown.text = quiet
      shown.whenMs = quietWhenMs
      shown.quietAtMs = 0.0
      shown.quietText = null
    }
  }

  /**
   * A truly absent field. `optString` answers the four-letter text "null" for a
   * JSON null, which the app sends for every optional field it has no value for.
   */
  private fun optionalString(json: JSONObject, key: String): String? {
    if (json.isNull(key)) return null
    return json.optString(key).ifEmpty { null }
  }

  private companion object {
    /** The app's primary colour by day (`global.css`). */
    const val DEFAULT_COLOR = "#4F5A10"
  }
}