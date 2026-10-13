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
   * One line that only the expanded notification shows, under the text: the
   * cost so far. The collapsed header never carries it.
   */
  expandedText: string | null;
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
  /**
   * The state time, in epoch milliseconds; 0 when none is known. Only a
   * Working card draws it, as its counting-up timer; on every other card it
   * orders the shade, and the text names the absolute time instead.
   */
  whenMs: number;
  /**
   * True while the card counts up from `whenMs` on the system clock. The
   * Working card carries no elapsed text of its own: the system timer is the
   * only one that stays right while nothing runs.
   */
  chronometer: boolean;
  /**
   * A Working card that is not quiet yet: the epoch time its quiet window ends,
   * else 0. At that time the native side posts the card again with
   * `quietText`, and its timer counts from `quietWhenMs` (the last activity).
   */
  quietAtMs: number;
  quietWhenMs: number;
  quietText: string | null;
  promotion: boolean;
  color: string;
};

/**
 * One stored session card as native storage keeps it. Only the facts the follow
 * lifecycle needs are read back: the session, its scope, and the approval key
 * the card shows. A card that no longer parses is dropped, which costs one
 * notification.
 */
/**
 * The native store writes an absent optional field as the empty string (Kotlin
 * `toJson`), so both forms read as null here. Without this, a Personal follow
 * (no organization) never matched its scope and was cancelled at every restore.
 */
const storedOptionalStringSchema = z
  .string()
  .nullable()
  .transform(value => (value === null || value.length === 0 ? null : value));

const storedSessionCardSchema = z.object({
  sessionId: z.string().min(1),
  organizationId: storedOptionalStringSchema,
  approvalKey: storedOptionalStringSchema,
  /**
   * Set on a finished card: the epoch time its window ends. It is kept so a
   * teardown can cancel it, and is never followed again.
   */
  finishedUntil: z.number().optional(),
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
