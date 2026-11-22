package com.kilocode.activeagentsliveupdate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The identity of a followed session's Android records, on the JVM.
 *
 * A notification is identified by its (tag, id) pair and a `PendingIntent` by
 * its request code together with its intent, so these values decide which card
 * and which action record each followed session owns.
 */
class SessionNotificationIdentityTest {
  @Test
  fun `every session id gets its own tag and its own action data`() {
    val ids = listOf("ses_01HQ", "ses_01HR", "ses_01JQ8ZK4M2XW3T7YB6NCV0000")
    val tags = ids.map(SessionNotificationIdentity::tag)
    val data = ids.map(SessionNotificationIdentity::sessionData)
    assertEquals(tags.size, tags.toSet().size)
    assertEquals(data.size, data.toSet().size)
  }

  @Test
  fun `a session id is never named by its card tag or its action data together`() {
    // The tag and the data URI are the two values that name one session, so a
    // session whose ids differ in either half owns a different record.
    val first = "ses_01JQ8ZK4M2XW3T7YB6NCV0000"
    val second = "ses_01JQ8ZK4M2XW3T7YB6NCV2662"
    assertNotEquals(SessionNotificationIdentity.tag(first), SessionNotificationIdentity.tag(second))
    assertNotEquals(
      SessionNotificationIdentity.sessionData(first),
      SessionNotificationIdentity.sessionData(second)
    )
    assertNotEquals(SessionNotificationIdentity.tag(first), SessionNotificationIdentity.LEGACY_TAG)
    assertNotEquals(SessionNotificationIdentity.tag(second), SessionNotificationIdentity.LEGACY_TAG)
  }

  @Test
  fun `the card tag is the whole session id, so a prefix of it names nothing`() {
    val sessionId = "ses_01JQ8ZK4M2XW3T7YB6NCV0000"
    assertEquals(SessionNotificationIdentity.tag(sessionId).substringAfterLast(':'), sessionId)
    assertEquals(SessionNotificationIdentity.sessionData(sessionId).substringAfterLast('/'), sessionId)
  }

  @Test
  fun `the data URI percent-encodes everything outside the unreserved set`() {
    assertEquals(
      "kiloapp://active-agents/session/a%2Fb%3Fc%23d%20e",
      SessionNotificationIdentity.sessionData("a/b?c#d e")
    )
    assertEquals(
      "kiloapp://active-agents/session/ses_01-HQ.abc~123",
      SessionNotificationIdentity.sessionData("ses_01-HQ.abc~123")
    )
    assertTrue(SessionNotificationIdentity.sessionData("ses_01-HQ.abc~123").none { it == '%' })
  }

  @Test
  fun `the session notification id is positive and never the aggregate card's`() {
    assertTrue(SessionNotificationIdentity.NOTIFICATION_ID > 0)
    assertNotEquals(1001, SessionNotificationIdentity.NOTIFICATION_ID)
  }

  @Test
  fun `the card a published build drew is still named by its own session id`() {
    // An update keeps naming the card record a published build drew, so that
    // build's card is cancelled when the session is posted or cancelled here.
    val sessionId = "ses_01HQ"
    assertEquals(
      20_000 + (sessionId.hashCode() and 0xFFFF),
      SessionNotificationIdentity.legacyNotificationId(sessionId)
    )
    assertEquals(
      (sessionId.hashCode() and 0xFFFF) * 4 + 3,
      SessionNotificationIdentity.legacyRequestCode(sessionId, 3)
    )
    assertEquals("session", SessionNotificationIdentity.LEGACY_TAG)
  }
}
