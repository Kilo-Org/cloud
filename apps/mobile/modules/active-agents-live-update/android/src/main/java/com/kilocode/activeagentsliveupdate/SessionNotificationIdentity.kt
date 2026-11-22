package com.kilocode.activeagentsliveupdate

/**
 * The identity of one followed session's Android records: its notification and
 * the `PendingIntent` of each of its actions.
 *
 * A notification is identified by the pair (tag, id), and a `PendingIntent` by
 * its request code together with the intent's component, action and data URI.
 * Both halves of the notification pair and the intent data therefore carry the
 * whole session id here, so each followed session owns exactly one card and its
 * own action records, whatever the ids are. Request codes are constants per
 * action kind, because the data URI names the session.
 *
 * One card means one record per action it shows, and the card and its records
 * are retired together: `SessionNotifications.cancel` reads the stored card,
 * then names each of its records through these values and cancels it.
 *
 * The Approve record is the one action whose answer depends on which request
 * the card shows, so it is named by the session and the ask ([askData]) rather
 * than by the session alone: a newer ask is a different record, and posting it
 * cannot rewrite the record of the ask a card still in the shade shows.
 *
 * [legacyNotificationId] and [legacyRequestCode] name the record identity that
 * an earlier app version used, so an update retires the card that version
 * posted together with its own action records, not only the card.
 *
 * Pure Kotlin, with no Android import, so the JVM unit test beside it runs
 * without a device.
 */
internal object SessionNotificationIdentity {
  /**
   * The one notification id every session card uses; the tag names the session.
   * The aggregate card is id 1001 with no tag, so this id cannot clash with it.
   */
  const val NOTIFICATION_ID = 20_001

  /** The tag an earlier app version posted every session card under. */
  const val LEGACY_TAG = "session"

  /** The id base that version added the low 16 hash bits of the session id to. */
  private const val LEGACY_ID_BASE = 20_000

  /**
   * The request-code offset that version gave one action kind: Open, Approve,
   * Dismiss and the quiet alarm, in that order. Its code was
   * `(hash and 0xFFFF) * 4 + offset`, so these four stay together and apart.
   */
  const val LEGACY_OPEN_OFFSET = 0
  const val LEGACY_APPROVE_OFFSET = 1
  const val LEGACY_DELETE_OFFSET = 2
  const val LEGACY_QUIET_OFFSET = 3

  private const val TAG_PREFIX = "followed-session:"
  private const val DATA_BASE = "kiloapp://active-agents/session/"

  /** The path segment that separates a session's ask from the session itself. */
  private const val ASK_SEGMENT = "/ask/"

  private const val HEX = "0123456789ABCDEF"

  /** The notification tag of one session: the session id, prefixed. */
  fun tag(sessionId: String): String = TAG_PREFIX + sessionId

  /** The data URI that names one session on its action intents. */
  fun sessionData(sessionId: String): String = DATA_BASE + encode(sessionId)

  /**
   * The data URI that names one request of one session on its Approve intent.
   * Two asks of one session answer different requests, so they must not share a
   * record: the ask is part of the identity, so a card still in the shade keeps
   * the record of the request it shows even after a newer ask was built.
   */
  fun askData(sessionId: String, approvalKey: String): String =
    sessionData(sessionId) + ASK_SEGMENT + encode(approvalKey)

  /** The notification id the earlier app version gave a session card. */
  fun legacyNotificationId(sessionId: String): Int =
    LEGACY_ID_BASE + (sessionId.hashCode() and 0xFFFF)

  /** The request code the earlier app version gave one of a session's actions. */
  fun legacyRequestCode(sessionId: String, offset: Int): Int =
    (sessionId.hashCode() and 0xFFFF) * 4 + offset

  /**
   * Percent-encode `value` for the path of a data URI: `A-Z a-z 0-9 - . _ ~`
   * stay, and every other UTF-8 byte is written `%XX` in upper-case hex. The
   * encoder is local so this object, and its test, need nothing from Android.
   */
  private fun encode(value: String): String {
    val encoded = StringBuilder()
    for (byte in value.toByteArray(Charsets.UTF_8)) {
      val code = byte.toInt() and 0xFF
      if (isUnreserved(code)) {
        encoded.append(code.toChar())
      } else {
        encoded.append('%')
        encoded.append(HEX[code shr 4])
        encoded.append(HEX[code and 0x0F])
      }
    }
    return encoded.toString()
  }

  private fun isUnreserved(code: Int): Boolean =
    code in 'A'.code..'Z'.code ||
      code in 'a'.code..'z'.code ||
      code in '0'.code..'9'.code ||
      code == '-'.code ||
      code == '.'.code ||
      code == '_'.code ||
      code == '~'.code
}
