package com.kilocode.activeagentsliveupdate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The identity of a followed session's Android records, on the JVM.
 *
 * A notification is identified by its (tag, id) pair and a `PendingIntent` by
 * its request code and intent, so these two pairs decide which card and which
 * action record each followed session owns, and what an update must cancel.
 */
class SessionNotificationIdentityTest {
  @Test
  fun `two ids with the same hash get distinct records`() {
    // Two distinct sessions whose ids share a hash.
    assertEquals("Aa".hashCode(), "BB".hashCode())
    assertEquals(
      SessionNotificationIdentity.legacyNotificationId("Aa"),
      SessionNotificationIdentity.legacyNotificationId("BB")
    )
    assertNotEquals(
      SessionNotificationIdentity.tag("Aa"),
      SessionNotificationIdentity.tag("BB")
    )
    assertNotEquals(
      SessionNotificationIdentity.sessionData("Aa"),
      SessionNotificationIdentity.sessionData("BB")
    )
  }

  @Test
  fun `two ordinary session ids get distinct tags and distinct data`() {
    val first = "ses_01HQ"
    val second = "ses_01HR"
    assertNotEquals(SessionNotificationIdentity.tag(first), SessionNotificationIdentity.tag(second))
    assertNotEquals(
      SessionNotificationIdentity.sessionData(first),
      SessionNotificationIdentity.sessionData(second)
    )
    assertNotEquals(SessionNotificationIdentity.tag(first), SessionNotificationIdentity.LEGACY_TAG)
    assertNotEquals(SessionNotificationIdentity.tag(second), SessionNotificationIdentity.LEGACY_TAG)
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
    assertFalse(
      SessionNotificationIdentity.sessionData("ses_01-HQ.abc~123").contains('%')
    )
  }

  @Test
  fun `the session notification id is positive and never the aggregate card's`() {
    assertTrue(SessionNotificationIdentity.NOTIFICATION_ID > 0)
    assertNotEquals(1001, SessionNotificationIdentity.NOTIFICATION_ID)
  }

  @Test
  fun `the earlier card identity is stable for the update to cancel`() {
    val sessionId = "ses_01HQ"
    assertEquals(
      20_000 + (sessionId.hashCode() and 0xFFFF),
      SessionNotificationIdentity.legacyNotificationId(sessionId)
    )
    assertEquals(
      (sessionId.hashCode() and 0xFFFF) * 4 + 3,
      SessionNotificationIdentity.legacyRequestCode(sessionId, 3)
    )
    assertFalse(SessionNotificationIdentity.LEGACY_TAG.isEmpty())
  }
}
