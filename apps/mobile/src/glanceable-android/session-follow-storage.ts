/**
 * The launch reconcile: what a launch, a foreground or a headless push rebuilds
 * from native truth and the stored scope. Split out of `session-follow.ts` so the
 * follow set and the stored-card reconcile each stay inside the line budget.
 */

import { ensureAndroidNotificationChannels } from './ensure-notification-channels';
import {
  dismissSessionCard,
  getStoredSessionCards,
  pruneSessionCards,
} from './session-notification';
import { restoreFollowedSessionCards, type SessionFollowContext } from './session-follow';
import { readStoredContext } from './session-stored-context';

/** Cancel the stored cards that belong to another account or scope, and nothing else. */
function dismissForeignSessionCards(ctx: SessionFollowContext | null): void {
  const stored = getStoredSessionCards();
  // No context is no signed-in account: every stored card belongs to someone else.
  const owned =
    ctx === null
      ? []
      : stored.filter(
          card => card.userId === ctx.userId && card.organizationId === ctx.organizationId
        );
  for (const card of stored) {
    if (!owned.includes(card)) {
      dismissSessionCard(card.sessionId);
    }
  }
  if (owned.length !== stored.length) {
    pruneSessionCards(owned.map(card => card.sessionId));
  }
}

/**
 * Launch, foreground, and a headless push: rebuild the set from native truth
 * and the stored scope. Resolves false when the keychain could not be read:
 * nothing is cancelled then, and the caller must not read the empty set as
 * "not followed".
 */
export async function restoreFollowedSessionCardsFromStorage(): Promise<boolean> {
  const ctx = await readStoredContext();
  if (ctx === 'unavailable') {
    return false;
  }
  // Another account's or scope's card goes first and on its own: it must never be
  // shown again, whatever happens to the channels.
  dismissForeignSessionCards(ctx);
  if (!(await ensureAndroidNotificationChannels())) {
    // A restore posts the card through its channel, so a failed pass would leave it
    // unposted and never reposted. The in-memory follow set is therefore still
    // empty, which must not read as "this device follows nothing": the callers
    // refuse to act on an unknown set, and the next launch reconciles again.
    return false;
  }
  restoreFollowedSessionCards(ctx);
  return true;
}
