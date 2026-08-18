import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { announceForA11y } from './announce';

// Shared async-status announcement contract (P2-C-15a). One channel per
// platform prevents double announcements:
//   - Android: `AccessibleStatus` renders a polite live region, so the OS
//     announces the text natively when it changes.
//   - iOS: there is no live-region concept, so `useStatusAnnouncement`
//     announces imperatively through `announceForA11y`.
// `nextAnnouncement` dedupes the transition so a re-render with the same
// message never re-announces, a cleared status stays silent, and a genuinely
// new message is spoken exactly once.

/**
 * Return the announcement to speak for the status transition `prev -> next`.
 *
 * Returns `next` (trimmed) only when it is non-empty and differs from `prev`;
 * otherwise `null`. "Repeat" (same message again) and "clear" (back to `null`
 * or empty) are silent, so a stray re-render cannot re-announce a status.
 */
export function nextAnnouncement(prev: string | null, next: string | null): string | null {
  const trimmed = next?.trim();
  if (trimmed == null || trimmed === '') {
    return null;
  }
  if (trimmed === prev?.trim()) {
    return null;
  }
  return trimmed;
}

/**
 * Announce `message` once per real change, but only on iOS. Android receives
 * the same status through the `AccessibleStatus` live region, so announcing
 * here too would double the announcement.
 *
 * The announcement is best-effort: `announce.ts` documents that an
 * accessibility outage (or a missing native bridge) must never break the UI,
 * so a failed call is swallowed and the visible status text remains the source
 * of truth.
 */
export function useStatusAnnouncement(message: string | null): void {
  const prevRef = useRef<string | null>(null);

  useEffect(() => {
    const next = nextAnnouncement(prevRef.current, message);
    prevRef.current = message;
    if (Platform.OS === 'ios' && next != null) {
      announceForA11y(next);
    }
  }, [message]);
}
