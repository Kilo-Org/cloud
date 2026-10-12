import { requireOptionalNativeModule } from 'expo';
import { z } from 'zod';

/**
 * The session-notification half of the local `ActiveAgentsLiveUpdate` native
 * module: one followed session's ongoing notification
 * (`.specs/mobile-session-live-activity.md` "Android").
 *
 * The cards cross the bridge as JSON text: Expo's record converter rejects a
 * null inside an object argument, and a card carries nullable fields. This file
 * owns the bridge only; the native module owns the notification id, the silent
 * channel, the actions, and the Live Update promotion.
 */

/** One followed session's notification, as the native module draws it. */
export type SessionNotificationCard = {
  sessionId: string;
  /** The scope the card was followed in; null for Personal. */
  organizationId: string | null;
  title: string;
  text: string;
  subText: string | null;
  /**
   * The status chip of a promoted Live Update: the wait or wake time that fits
   * one short line, else null.
   */
  compactText: string | null;
  openLabel: string;
  openUrl: string;
  /** Approve is added only when `approvalKey` names the request the card shows. */
  approveLabel: string | null;
  approvalKey: string | null;
  /** The time the card shows, in epoch milliseconds; 0 when it shows none. */
  whenMs: number;
  showWhen: boolean;
  /**
   * True while the card counts up from `whenMs` on the system clock. The
   * Working card carries no elapsed text of its own: the system timer is the
   * only one that stays right while nothing runs.
   */
  chronometer: boolean;
  promotion: boolean;
  color: string;
};

/**
 * One stored session card as native storage keeps it. Only the facts the follow
 * lifecycle needs are read back: the session, its scope, and the approval key
 * the card shows. A card that no longer parses is dropped, which costs one
 * notification.
 */
const storedSessionCardSchema = z.object({
  sessionId: z.string().min(1),
  organizationId: z.string().nullable(),
  approvalKey: z.string().nullable(),
});

export type StoredSessionCard = z.infer<typeof storedSessionCardSchema>;

const storedSessionCardsSchema = z.array(z.unknown());

type SessionNotificationNativeModule = {
  postSession(cardJson: string, dismissAfterMs: number): void;
  dismissSession(sessionId: string): void;
  pruneSessions(keepJson: string): void;
  getSessionCards(): string;
};

const nativeModule =
  requireOptionalNativeModule<SessionNotificationNativeModule>('ActiveAgentsLiveUpdate');

/** Post or update one followed session's ongoing notification. */
export function postSessionCard(card: SessionNotificationCard, dismissAfterMs = 0): void {
  nativeModule?.postSession(JSON.stringify(card), dismissAfterMs);
}

/** Cancel one session's notification and forget its stored card. */
export function dismissSessionCard(sessionId: string): void {
  nativeModule?.dismissSession(sessionId);
}

/**
 * Cancel every stored session card whose id is not in `keep`. The app calls this
 * after a restart or a scope change, so a notification the app no longer counts
 * cannot stay in the shade.
 */
export function pruneSessionCards(keep: readonly string[]): void {
  nativeModule?.pruneSessions(JSON.stringify(keep));
}

/**
 * The session cards the native module still stores, as the app posted them.
 * Native storage is authoritative: a notification outlives the process that
 * posted it, so a fresh process rebuilds the followed set from here.
 */
export function getStoredSessionCards(): StoredSessionCard[] {
  try {
    const parsed = storedSessionCardsSchema.safeParse(
      JSON.parse(nativeModule?.getSessionCards() ?? '[]')
    );
    if (!parsed.success) {
      return [];
    }
    // One unreadable record must not hide the others: dropping every card would
    // cancel the notifications the app still counts.
    const cards: StoredSessionCard[] = [];
    for (const value of parsed.data) {
      const card = storedSessionCardSchema.safeParse(value);
      if (card.success) {
        cards.push(card.data);
      }
    }
    return cards;
  } catch {
    return [];
  }
}
