import { getLiveActivityEnabled } from '@/lib/glanceable/live-activity-switch';
import {
  registerSessionActivityToken,
  retrySessionActivityTokens,
} from '@/lib/glanceable/session-activity-tokens';
import { getGlanceableDelivery } from '@/lib/glanceable/sink-registry';

import * as cardScopes from './session-card-scope';
import {
  discoverSessionCards,
  endAllSessionCards,
  endCard,
  forgetFollow,
  isSessionCardDiscoveryReadable,
  type SessionFollowContext,
} from './session-follow';

/**
 * What a launch or foreground restore knows about the stored account: the scope
 * it read, a keychain that answered with no account, or a keychain that could
 * not answer at all. Only the first keeps a card, and only the last leaves the
 * cards as they are (`session-stored-context.ts` reads the same three states on
 * Android).
 */
export type SessionRestoreScope =
  | { kind: 'account'; ctx: SessionFollowContext }
  | { kind: 'signedOut' }
  | { kind: 'unreadable' };

/**
 * The stored-account read. The restore calls it only when a live card needs its
 * scope: on a device with nothing to place it would spend the credential retry
 * budget and decide nothing.
 */
export type SessionRestoreScopeReader = () => Promise<SessionRestoreScope>;

/**
 * End every session card and its token scope, as a teardown does: the token
 * scope retires first, so it reads each card's token before the end drops it.
 */
function retireEverySessionCard(): void {
  getGlanceableDelivery().cleanupTokens('scope');
  endAllSessionCards();
}

/**
 * Launch and foreground: rebuild the map, then register again the cards this
 * account and organization followed. A card's follow scope travels in the
 * device record (`session-card-scope.ts`), never in the card: the server
 * replaces the card's whole content state on every push, so the card cannot
 * keep it. A card whose record is absent (written by an earlier build) or names
 * another account or organization is out of scope and ends here.
 *
 * `readScope` runs only when a card decision needs the account: live cards to
 * place, or a discovery that could not read ActivityKit, whose live set says
 * nothing. A keychain that answered with no account is a sign-out this process
 * did not finish: no card can be in scope, so every card ends, as it does on an
 * in-app sign-out. Only a keychain or a record store that cannot be read now,
 * like a locked keychain before first unlock, leaves the cards as they are.
 * A registration that failed earlier retries here (spec "Error Handling" 4).
 */
export async function restoreFollowedSessionCards(
  readScope: SessionRestoreScopeReader
): Promise<void> {
  if (!getLiveActivityEnabled()) {
    // The in-app switch turned off while no process ran: no card may stay.
    retireEverySessionCard();
    return;
  }
  const live = discoverSessionCards();
  // Capture this restore's own discovery result before the await: another
  // restore or a Follow can run a different discovery in the meantime.
  const discoveryRead = isSessionCardDiscoveryReadable();
  if (live.length === 0 && discoveryRead) {
    // No card is live, so no card is out of scope and no token can be retired:
    // the stored-account read stays unspent, with its credential retry budget.
    // Only records a card left behind can still need retiring.
    const records = await cardScopes.readSessionCardScopes();
    if (records !== null) {
      cardScopes.pruneSessionCardScopes([], records);
    }
    return;
  }
  // The record snapshot comes before the stored-account read: a Follow that
  // lands during the scope await (the keychain read yields) enqueues its
  // write after this snapshot, so the prune below keeps it, while a restore
  // from a surface it read before the snapshot cannot resurrect a record.
  const records = await cardScopes.readSessionCardScopes();
  const stored = await readScope();
  if (stored.kind === 'unreadable') {
    // A keychain that cannot answer says nothing about the stored account, so
    // it may not cost a card: the next foreground reads it again.
    return;
  }
  if (stored.kind === 'signedOut') {
    // Sign-out ended the cards from its own process, so a card still live here
    // outlived the account that followed it: a killed app, or a session
    // removed elsewhere.
    retireEverySessionCard();
    return;
  }
  const ctx = stored.ctx;
  if (records === null) {
    return;
  }
  const kept: string[] = [];
  for (const activity of live) {
    const sessionId = activity.getProps()?.sessionId;
    const scope = sessionId === undefined ? undefined : records.get(sessionId);
    if (sessionId === undefined) {
      endCard(activity, 'immediate');
    } else if (scope !== undefined && cardScopes.isSessionCardScopeCurrent(scope, ctx)) {
      kept.push(sessionId);
      registerSessionActivityToken(activity.getId(), activity, { sessionId, ...scope });
    } else {
      // A card no record names (an earlier build kept none), or one followed
      // under another account or organization: it is out of scope.
      forgetFollow(sessionId);
      endCard(activity, 'immediate');
    }
  }
  // An unreadable ActivityKit read proves nothing about which cards are live, so
  // its empty result must not prune the records the cards still rely on.
  if (discoveryRead) {
    cardScopes.pruneSessionCardScopes(kept, records);
  }
  retrySessionActivityTokens();
}
