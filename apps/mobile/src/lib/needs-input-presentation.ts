/**
 * The app-owned needs-input notification's identity and what the OS says about
 * it, split out of `needs-input-notification.ts` so the plan and the marker each
 * stay inside the line budget.
 *
 * `posting` the marker is the app's own memory; the OS is the authority on
 * whether the notification is still on screen, because a swipe never reaches the
 * app.
 */

import * as Notifications from 'expo-notifications';

const IDENTIFIER_PREFIX = 'needs-input:';

/** The identifier a session's needs-input notification is posted and replaced under. */
export function notificationIdentifierForSession(kiloSessionId: string): string {
  return `${IDENTIFIER_PREFIX}${kiloSessionId}`;
}

/**
 * True when a notification request identifier belongs to the app's own
 * needs-input post. The foreground handler reads it so it can suppress the
 * server's attention push without suppressing the app's own notification,
 * which carries the same parsed payload (both must dispatch the same actions).
 */
export function isAppOwnedNeedsInputNotification(identifier: string | null | undefined): boolean {
  return (identifier ?? '').startsWith(IDENTIFIER_PREFIX);
}

/** The session an app-owned identifier belongs to, or null for another notification. */
export function needsInputSessionOfIdentifier(identifier: string): string | null {
  return identifier.startsWith(IDENTIFIER_PREFIX)
    ? identifier.slice(IDENTIFIER_PREFIX.length)
    : null;
}

// The sessions whose app-owned needs-input notification was posted. Only a fast
// path: the OS is the authority on whether it is still on screen, because a swipe
// never reaches the app. In-memory like the mount's notified set: a fresh process
// posts nothing until the cached rows raise again, so a restart can only
// under-report (a duplicate server push may show once), never suppress a raise
// that has no notification.
const postedSessions = new Set<string>();

/** Record that the app's own notification for this session reached the OS. */
export function markNeedsInputPosted(kiloSessionId: string): void {
  postedSessions.add(kiloSessionId);
}

/** Drop the posted marker once the raise's presentation is gone (result or dismissal). */
export function clearPostedNeedsInputNotification(kiloSessionId: string): void {
  postedSessions.delete(kiloSessionId);
}

/**
 * What the OS says about the app's own needs-input notification for a session.
 * `unknown` means the OS could not be asked; a caller must never withhold a
 * presentation on `unknown`.
 */
export type NeedsInputPresentation = 'presented' | 'absent' | 'unknown';

/**
 * Whether the app's own needs-input notification is on screen right now.
 *
 * The marker alone cannot answer this: the user can swipe the notification away
 * and the SDK exposes no dismissal listener, so a stale marker would suppress the
 * server's attention push for a raise that then has no notification at all. The
 * marker is verified against the OS and dropped when the OS no longer holds it.
 * A read that throws reports `unknown` and suppresses nothing.
 */
export async function readNeedsInputPresentation(
  kiloSessionId: string
): Promise<NeedsInputPresentation> {
  if (!postedSessions.has(kiloSessionId)) {
    return 'absent';
  }
  const identifier = notificationIdentifierForSession(kiloSessionId);
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    if (presented.some(notification => notification.request.identifier === identifier)) {
      return 'presented';
    }
    postedSessions.delete(kiloSessionId);
    return 'absent';
  } catch {
    return 'unknown';
  }
}
