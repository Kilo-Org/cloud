package com.kilocode.activeagentsliveupdate

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import org.json.JSONArray
import org.json.JSONException
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
 * The module holds exactly one notification per session, tagged with the
 * session id, so an update can only reach that session's card. Each action
 * carries the session in its Intent data for the same reason, and Approve
 * carries the ask it answers as well, so a newer ask is a different record and
 * a post that does not land leaves the card in the shade answering the request
 * it shows; see `SessionNotificationIdentity`. SharedPreferences keeps the
 * card's facts and the scope it was followed in, so a press can answer with the
 * right organization after the process was killed, and so a restart can prune
 * the cards that are no longer in the shade.
 */
internal object SessionNotifications {
  private const val STORE = "active_agents_session_notifications"
  private const val KEY_PREFIX = "session:"
  /** Superseded asks of one session that a later pass still has to retire. */
  private const val RETIRING_PREFIX = "retiring:"
  private const val CHANNEL_ID = "followed-sessions-lock-screen"

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

  /**
   * Cancel one session's card and the records it owns, and forget it.
   *
   * One session has one card and one record per action it shows, and they are
   * retired together: the notification, its quiet alarm, and the Open, Approve
   * and Dismiss records all go with the session, so nothing of a session that is
   * no longer followed stays behind. The card a released build posted is
   * retired here too; see [cancelLegacy].
   */
  fun cancel(context: Context, sessionId: String) {
    // Read the card first: its own deep link and approval key are what name the
    // Open and Approve records, and the removal below drops them.
    val card = storedCard(context, sessionId)
    manager(context).cancel(
      SessionNotificationIdentity.tag(sessionId),
      SessionNotificationIdentity.NOTIFICATION_ID
    )
    state(context)
      .edit()
      .remove(KEY_PREFIX + sessionId)
      .commitOrReport("Cannot forget the cancelled session card")
    alarms(context).cancel(quietIntent(context, sessionId, 0))
    cancelActions(context, sessionId, card)
    // A superseded ask a crash left recorded is not named by the card, so the
    // teardown retires it from its own record.
    sweepRetiring(context, sessionId)
    cancelLegacy(context, sessionId, card)
  }

  /** The stored card of one session, as it was posted, or null when none is stored. */
  private fun storedCard(context: Context, sessionId: String): SessionNotificationCard? {
    val stored = state(context).getString(KEY_PREFIX + sessionId, null) ?: return null
    return SessionNotificationCard().apply { fillFromJson(JSONObject(stored)) }
  }

  /**
   * Cancel the action records one stored card owns: Open on the card's deep
   * link, Approve on its claim, and Dismiss on its session. The set is the
   * card's own, because the builder adds the same three from the same fields —
   * Approve only with an approval key, Open only with a deep link — so a card
   * that shows fewer actions owns fewer records. Each is retrieved with
   * `FLAG_NO_CREATE`, which cancels a record that exists and answers null
   * instead of creating one when it does not.
   *
   * The Approve record is retired under both identities a card can have posted
   * it under: the ask-keyed one this build builds, and the session-only one a
   * build before it used, so no stale Approve action outlives its card.
   */
  private fun cancelActions(context: Context, sessionId: String, card: SessionNotificationCard?) {
    val openUrl = card?.openUrl ?: ""
    if (openUrl.isNotEmpty()) {
      PendingIntent.getActivity(
        context,
        OPEN_REQUEST_CODE,
        openDeepLinkIntent(context, openUrl),
        PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
      )?.cancel()
    }
    card?.approvalKey?.let { approvalKey ->
      ApprovalGate.cancel(context, APPROVE_REQUEST_CODE, sessionId, approvalKey)
    }
    // A card posted before the Approve record carried its ask kept that record
    // under the session alone, so the teardown retires that identity too; a
    // record that never existed answers null. This cannot reach the aggregate
    // card's record, which has its own request code.
    ApprovalGate.cancel(context, APPROVE_REQUEST_CODE, sessionId, null)
    PendingIntent.getBroadcast(
      context,
      DELETE_REQUEST_CODE,
      dismissIntent(context, sessionId),
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
    )?.cancel()
  }

  /**
   * Retire the card record an earlier app version posted for this session, and
   * the records of its own actions. An update posts the card under the identity
   * above, so the record from the version before it is retired here — from
   * `post` as well as from `cancel` — or the same session would be drawn twice
   * until it ends.
   *
   * That version gave one session one card and one record per action, and they
   * are retired together here as they are in [cancelActions]: its Open record
   * on the card's deep link, its Approve record on the gate activity, and its
   * Dismiss record on the receiver, plus the notification and its quiet alarm,
   * which are cancelled rather than retrieved. Those shapes are the ones that
   * build produced, so nothing here builds a record it does not find.
   */
  private fun cancelLegacy(
    context: Context,
    sessionId: String,
    card: SessionNotificationCard?
  ) {
    manager(context).cancel(
      SessionNotificationIdentity.LEGACY_TAG,
      SessionNotificationIdentity.legacyNotificationId(sessionId)
    )
    PendingIntent.getBroadcast(
      context,
      SessionNotificationIdentity.legacyRequestCode(
        sessionId,
        SessionNotificationIdentity.LEGACY_QUIET_OFFSET
      ),
      Intent(context, ActiveAgentsActionReceiver::class.java)
        .setAction(ActiveAgentsActionReceiver.ACTION_QUIET)
        .putExtra(ActiveAgentsApproveWorker.KEY_SESSION_ID, sessionId),
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
    )?.let { operation ->
      alarms(context).cancel(operation)
      operation.cancel()
    }
    val openUrl = card?.openUrl ?: ""
    if (openUrl.isNotEmpty()) {
      // No component on that version's Open record: the deep link alone.
      PendingIntent.getActivity(
        context,
        SessionNotificationIdentity.legacyRequestCode(
          sessionId,
          SessionNotificationIdentity.LEGACY_OPEN_OFFSET
        ),
        Intent(Intent.ACTION_VIEW, Uri.parse(openUrl)).setPackage(context.packageName),
        PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
      )?.cancel()
    }
    // Its Approve record is the gate activity with no data, and its Dismiss
    // record the receiver's dismiss action with no data.
    PendingIntent.getActivity(
      context,
      SessionNotificationIdentity.legacyRequestCode(
        sessionId,
        SessionNotificationIdentity.LEGACY_APPROVE_OFFSET
      ),
      Intent(context, ActiveAgentsApprovalActivity::class.java),
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
    )?.cancel()
    PendingIntent.getBroadcast(
      context,
      SessionNotificationIdentity.legacyRequestCode(
        sessionId,
        SessionNotificationIdentity.LEGACY_DELETE_OFFSET
      ),
      Intent(context, ActiveAgentsActionReceiver::class.java)
        .setAction(ActiveAgentsActionReceiver.ACTION_DISMISS),
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
    )?.cancel()
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
   *
   * A post that does not land leaves the previous card in the shade, so it
   * leaves that card answering the request it shows: the stored facts go back
   * to it, and the Approve record of the newer ask this call built is dropped
   * because nothing shows it. The superseded ask's record is retired only after
   * the newer card is posted.
   */
  fun post(context: Context, card: SessionNotificationCard, dismissAfterMs: Long) {
    // One clock read for the whole post: the card drawn now and the quiet
    // alarm must agree on whether the quiet window has passed.
    val nowMs = System.currentTimeMillis()
    val timeoutMs = dismissAfterMs.coerceAtLeast(0)
    // Snapshot what the shade holds before this post replaces it: a failed post
    // leaves that card posted, so its stored facts must survive, and its
    // Approve record must keep answering the ask it shows.
    val previousJson = state(context).getString(KEY_PREFIX + card.sessionId, null)
    val previousApprovalKey = approvalKeyOf(previousJson)
    val stored = card.toJson()
    if (timeoutMs > 0) {
      stored.put(FINISHED_UNTIL, nowMs + timeoutMs)
    }
    state(context)
      .edit()
      .putString(KEY_PREFIX + card.sessionId, stored.toString())
      .commitOrReport("Cannot persist the followed session card")
    // Retire the earlier build's records before this post builds its own, so
    // the retirement can only act on what the earlier build left behind.
    cancelLegacy(context, card.sessionId, card)
    try {
      val builder = builder(context, card.shownAt(nowMs))
      if (timeoutMs > 0 && Build.VERSION.SDK_INT >= 26) {
        builder.setTimeoutAfter(timeoutMs)
      }
      manager(context).notify(
        SessionNotificationIdentity.tag(card.sessionId),
        SessionNotificationIdentity.NOTIFICATION_ID,
        builder.build()
      )
      // `notify` answers nothing, and it drops a post whose channel the user
      // disabled instead of throwing. A card that is not in the shade leaves the
      // previous card there, so this post did not land either.
      if (!isPosted(context, card.sessionId)) {
        abandonPost(context, card, previousJson, previousApprovalKey)
        return
      }
    } catch (error: Throwable) {
      abandonPost(context, card, previousJson, previousApprovalKey)
      throw error
    }
    // The post landed: record the superseded ask before retiring it, so a
    // process that dies between these two steps cannot leave its record behind
    // with nothing left to name it.
    sweepRetiring(context, card.sessionId)
    if (previousApprovalKey != null && previousApprovalKey != card.approvalKey) {
      retire(context, card.sessionId, previousApprovalKey)
    }
    scheduleQuiet(context, card, nowMs)
  }

  /**
   * The post did not land: the previous card is still in the shade, so put back
   * the facts that describe it and drop the record of a newer ask, which no card
   * shows. A record for the ask the surviving card shows is left alone, and no
   * quiet moment is armed for a card that is not there.
   */
  private fun abandonPost(
    context: Context,
    card: SessionNotificationCard,
    previousJson: String?,
    previousApprovalKey: String?
  ) {
    restoreStored(context, card.sessionId, previousJson)
    if (card.approvalKey != null && card.approvalKey != previousApprovalKey) {
      ApprovalGate.cancel(context, APPROVE_REQUEST_CODE, card.sessionId, card.approvalKey)
    }
  }

  /**
   * Is this session's card in the shade? A tag-and-id pair names it, so the read
   * cannot match another session's card.
   */
  private fun isPosted(context: Context, sessionId: String): Boolean =
    manager(context).activeNotifications.any {
      it.tag == SessionNotificationIdentity.tag(sessionId) &&
        it.id == SessionNotificationIdentity.NOTIFICATION_ID
    }

  /**
   * Retire one superseded ask's record, naming it in the persisted set first: a
   * crash between the two steps then leaves the ask for the next post or teardown
   * to sweep, instead of a record nothing names again.
   */
  private fun retire(context: Context, sessionId: String, approvalKey: String) {
    updateRetiring(context, sessionId) { keys -> keys + approvalKey }
    ApprovalGate.cancel(context, APPROVE_REQUEST_CODE, sessionId, approvalKey)
    updateRetiring(context, sessionId) { keys -> keys - approvalKey }
  }

  /** Cancel every record a superseded ask left named for this session. */
  private fun sweepRetiring(context: Context, sessionId: String) {
    val keys = retiring(context, sessionId)
    if (keys.isEmpty()) {
      return
    }
    for (key in keys) {
      ApprovalGate.cancel(context, APPROVE_REQUEST_CODE, sessionId, key)
    }
    updateRetiring(context, sessionId) { emptySet() }
  }

  /** The superseded asks of one session that a later pass still has to retire. */
  private fun retiring(context: Context, sessionId: String): Set<String> {
    val raw = state(context).getString(RETIRING_PREFIX + sessionId, null) ?: return emptySet()
    return try {
      val array = JSONArray(raw)
      (0 until array.length()).map(array::getString).toSet()
    } catch (error: JSONException) {
      // A record that cannot be read names nothing to cancel; the teardown still
      // retires the identities a card carries.
      emptySet()
    }
  }

  private fun updateRetiring(
    context: Context,
    sessionId: String,
    change: (Set<String>) -> Set<String>
  ) {
    val keys = change(retiring(context, sessionId))
    val editor = state(context).edit()
    if (keys.isEmpty()) {
      editor.remove(RETIRING_PREFIX + sessionId)
    } else {
      editor.putString(RETIRING_PREFIX + sessionId, JSONArray(keys.toList()).toString())
    }
    editor.commitOrReport("Cannot record the retired session ask")
  }

  /**
   * Put back the stored card a failed post must keep describing, or forget the
   * entry when the shade holds no card of this session to describe.
   */
  private fun restoreStored(context: Context, sessionId: String, previousJson: String?) {
    val editor = state(context).edit()
    if (previousJson == null) {
      editor.remove(KEY_PREFIX + sessionId)
    } else {
      editor.putString(KEY_PREFIX + sessionId, previousJson)
    }
    editor.commitOrReport("Cannot restore the followed session card")
  }

  /** The ask one stored card answers, or null when it stores none. */
  private fun approvalKeyOf(stored: String?): String? =
    stored?.let { SessionNotificationCard().apply { fillFromJson(JSONObject(it)) }.approvalKey }

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
    alarmWhileIdle(alarmManager, quietAt, operation)
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
      QUIET_REQUEST_CODE,
      Intent(context, ActiveAgentsActionReceiver::class.java)
        .setAction(ActiveAgentsActionReceiver.ACTION_QUIET)
        .setData(Uri.parse(SessionNotificationIdentity.sessionData(sessionId)))
        .putExtra(ActiveAgentsApproveWorker.KEY_SESSION_ID, sessionId)
        .putExtra(ActiveAgentsActionReceiver.EXTRA_QUIET_AT, quietAtMs),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

  private fun alarms(context: Context): AlarmManager =
    context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

  /**
   * The Open action's intent: the card's own deep link, claimed by this app
   * only. The builder and the cancel path both name the record through it, so
   * the two cannot disagree on the record's identity.
   */
  private fun openDeepLinkIntent(context: Context, openUrl: String): Intent =
    Intent(Intent.ACTION_VIEW, Uri.parse(openUrl)).setPackage(context.packageName)

  /**
   * The Dismiss action's intent, shared by the builder and the cancel path for
   * the same reason as [openDeepLinkIntent].
   */
  private fun dismissIntent(context: Context, sessionId: String): Intent =
    Intent(context, ActiveAgentsActionReceiver::class.java)
      .setAction(ActiveAgentsActionReceiver.ACTION_DISMISS)
      .setData(Uri.parse(SessionNotificationIdentity.sessionData(sessionId)))
      .putExtra(ActiveAgentsApproveWorker.KEY_SESSION_ID, sessionId)

  private fun builder(context: Context, card: SessionNotificationCard): Notification.Builder {
    val icon = CardStyle.icon(context)
    val openIntent = PendingIntent.getActivity(
      context,
      OPEN_REQUEST_CODE,
      openDeepLinkIntent(context, card.openUrl),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val builder = CardBuilders.builder(context, CHANNEL_ID)
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
    // carries no approval key, and it is the one action that changes the
    // agent's work, so it carries the presence gate.
    card.approveLabel?.let { label ->
      if (card.approvalKey != null) {
        builder.addAction(ApprovalGate.action(context, icon, label, approveIntent(context, card)))
      }
    }
    builder.addAction(CardBuilders.action(context, icon, card.openLabel, openIntent))

    // API 36.1+ Live Update: the one gate both Android cards request through.
    // An incapable or refused device keeps the expanded-only line below.
    if (card.promotion && PromotionGate.request(context, builder, card.compactText)) {
      if (card.chronometer) {
        builder.setChronometerCountDown(false)
      }
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

  /** Answer the exact request this card shows, through the presence gate. */
  private fun approveIntent(context: Context, card: SessionNotificationCard): PendingIntent {
    val approvalKey = card.approvalKey ?: return deleteIntent(context, card.sessionId)
    return ApprovalGate.pendingIntent(
      context,
      APPROVE_REQUEST_CODE,
      card.sessionId,
      approvalKey
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
      DELETE_REQUEST_CODE,
      dismissIntent(context, sessionId),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

  private fun manager(context: Context): NotificationManager =
    context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  /** Stored beside a finished card: the epoch time its window ends. */
  private const val FINISHED_UNTIL = "finishedUntil"

  // One request code per action kind. The session is named by each Intent's
  // data URI, so the code only has to separate the actions of one session.
  private const val OPEN_REQUEST_CODE = 0
  private const val APPROVE_REQUEST_CODE = 1
  private const val DELETE_REQUEST_CODE = 2
  private const val QUIET_REQUEST_CODE = 3
}

/** One followed session's notification, as the JS side maps it. */
class SessionNotificationCard : Record {
  @Field var sessionId: String = ""
  @Field var userId: String? = null
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
  @Field var color: String = CardStyle.PRIMARY_DAY

  fun toJson(): JSONObject = JSONObject().apply {
    put("sessionId", sessionId)
    // Kept so a restore can place the card in the account it was followed in;
    // never drawn (spec "Android: privacy").
    put("userId", userId ?: "")
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
    userId = optionalString(json, "userId")
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
    color = optionalString(json, "color") ?: CardStyle.PRIMARY_DAY
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
}