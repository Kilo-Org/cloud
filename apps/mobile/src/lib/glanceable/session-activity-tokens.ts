import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  attemptLogoutReconciliation,
  awaitLogoutReconciliationSettled,
  hasPendingActivityUnregister,
} from '@/lib/auth/logout-reconciliation';
import { getSessionLiveActivity } from '@/glanceable-ios/session-live-activity';
import { trpcClient } from '@/lib/trpc';

import { getGlanceableDelivery, type GlanceableActivity } from './sink-registry';
import { enqueueTokenMutation } from './token-mutation-queue';
import { deleteActivityTokens, readUnregisterAuthToken } from './unregister-session';

/**
 * The push tokens of the followed session cards (`ios_session_activity`,
 * `.specs/mobile-session-live-activity.md`). Each card has its own token and
 * its own server row, so one card's token never replaces another's, and the
 * aggregate card's single `ios_activity` registration is never touched.
 *
 * Registration shares the activity-token FIFO and the logout fences with the
 * aggregate card. Deletes go through the delivery (`cleanupTokens('session')`),
 * so a failed delete is tombstoned like every other activity token, and a scope
 * teardown deletes these tokens with the rest before the device session is
 * revoked.
 */

export type SessionActivityScope = {
  sessionId: string;
  organizationId: string | null;
  userId: string;
};

type Registration = SessionActivityScope & {
  epoch: number;
  authEpoch: number;
  token: string | null;
  registeredToken: string | null;
  subscription: { remove: () => void } | null;
};

/** Every attempted session card token until its delete succeeds. */
export const sessionActivityTokens = new Set<string>();

/** Live registrations by native activity id. */
const registrations = new Map<string, Registration>();
let epoch = 0;

function isCurrent(activityId: string, registration: Registration): boolean {
  return (
    registration.epoch === epoch &&
    isCurrentAuthEpoch(registration.authEpoch) &&
    registrations.get(activityId) === registration
  );
}

async function registerToken(
  activityId: string,
  registration: Registration,
  token: string
): Promise<void> {
  if (!isCurrent(activityId, registration) || token.length === 0) {
    return;
  }
  registration.token = token;
  if (registration.registeredToken === token) {
    return;
  }
  try {
    // Never wait for cleanup inside the mutation queue: cleanup needs that queue itself.
    void attemptLogoutReconciliation(registration.userId);
    await awaitLogoutReconciliationSettled();
    if (
      !isCurrent(activityId, registration) ||
      (await hasPendingActivityUnregister(registration.userId))
    ) {
      return;
    }
    // The callback returns the token this upsert replaced, if any.
    const rotatedFrom = await enqueueTokenMutation(async (): Promise<string | null> => {
      if (
        !isCurrent(activityId, registration) ||
        registration.token !== token ||
        registration.registeredToken === token
      ) {
        return null;
      }
      sessionActivityTokens.add(token);
      const previous = registration.registeredToken;
      await trpcClient.user.registerActivityToken.mutate({
        token,
        kind: 'ios_session_activity',
        platform: 'ios',
        organizationId: registration.organizationId,
        sessionId: registration.sessionId,
      });
      registration.registeredToken = token;
      return previous;
    });
    if (rotatedFrom !== null) {
      // iOS rotated the card's token. The new row is live, so the old row is
      // retired; outside the queue, because the delete runs through it.
      deleteSessionActivityToken(rotatedFrom);
    }
  } catch {
    // The card keeps its local content; `retrySessionActivityTokens` retries at
    // the next foreground. An uncertain upsert still needs cleanup, so the
    // token stays in the set.
  }
}

/**
 * Register one session card's push token, and every token iOS rotates to.
 * A second call for the same card retries a registration that has not landed.
 */
export function registerSessionActivityToken(
  activityId: string,
  activity: GlanceableActivity,
  scope: SessionActivityScope
): void {
  const existing = registrations.get(activityId);
  if (existing !== undefined && isCurrent(activityId, existing)) {
    if (existing.token !== null) {
      void registerToken(activityId, existing, existing.token);
    }
    return;
  }
  existing?.subscription?.remove();
  const registration: Registration = {
    ...scope,
    epoch,
    authEpoch: currentAuthEpoch(),
    token: null,
    registeredToken: null,
    subscription: null,
  };
  registrations.set(activityId, registration);
  try {
    registration.subscription = activity.addPushTokenListener(({ pushToken }) => {
      void registerToken(activityId, registration, pushToken);
    });
  } catch {
    // An unsupported native read leaves the card local; the next foreground retries.
  }
  void (async () => {
    try {
      const token = await activity.getPushToken();
      // A token event is newer than the initial asynchronous read.
      if (token !== null && registration.token === null) {
        await registerToken(activityId, registration, token);
      }
    } catch {
      // The listener above still delivers the token when iOS mints it.
    }
  })();
}

/** Retry every registration that has a token but no server row yet. */
export function retrySessionActivityTokens(): void {
  for (const [activityId, registration] of registrations) {
    if (registration.token !== null && registration.registeredToken !== registration.token) {
      void registerToken(activityId, registration, registration.token);
    }
  }
}

/** Delete one session card token's server row; a failure is tombstoned. */
export function deleteSessionActivityToken(token: string): void {
  getGlanceableDelivery().cleanupTokens(
    'session',
    new Promise<string>(resolve => {
      resolve(token);
    })
  );
}

/** The native ids of every card this process observes. */
export function observedSessionActivityIds(): string[] {
  return [...registrations.keys()];
}

/**
 * Stop observing one card. Returns the newest token the card reported, so the
 * caller can delete it (`cleanupTokens('session')`) when the native read can no
 * longer supply it.
 */
export function releaseSessionActivity(activityId: string): string | null {
  const registration = registrations.get(activityId);
  registration?.subscription?.remove();
  registrations.delete(activityId);
  return registration?.token ?? registration?.registeredToken ?? null;
}

/**
 * Stop observing every card: the scope is torn down and its tokens are deleted
 * with it. Returns every token the cards reported, registered or not.
 */
function releaseAllSessionActivities(): string[] {
  epoch += 1;
  const tokens: string[] = [];
  for (const registration of registrations.values()) {
    registration.subscription?.remove();
    for (const token of [registration.token, registration.registeredToken]) {
      if (token !== null) {
        tokens.push(token);
      }
    }
  }
  registrations.clear();
  return tokens;
}

/** Test-only: drop every registration and recorded token. */
export function _resetSessionActivityTokensForTests(): void {
  releaseAllSessionActivities();
  sessionActivityTokens.clear();
}

/**
 * Scope teardown: stop observing every card and record every session card
 * token for the scope delete, cards a previous process started included. The
 * native reads start now, before the cards end and drop their tokens; the
 * returned promise settles once they landed in `sessionActivityTokens`.
 */
export async function collectSessionScopeTokens(): Promise<void> {
  for (const token of releaseAllSessionActivities()) {
    sessionActivityTokens.add(token);
  }
  let instances: GlanceableActivity[] = [];
  try {
    instances = getSessionLiveActivity().getInstances(true);
  } catch {
    // The recorded tokens still cover every card this process observed.
  }
  const reads = instances.map(async instance => {
    try {
      return await instance.getPushToken();
    } catch {
      return null;
    }
  });
  for (const token of await Promise.all(reads)) {
    if (token !== null) {
      sessionActivityTokens.add(token);
    }
  }
}

/**
 * Delete one ended session card's token, in the activity-token FIFO. The
 * aggregate card's registration and the scope stay as they are. A failed or
 * unauthorized delete keeps the token for a tombstoned retry.
 */
export async function unregisterSessionActivityToken(
  activityToken?: Promise<string | null>
): Promise<{ ok: boolean; tokens: string[] }> {
  const result = await enqueueTokenMutation(async () => {
    let token: string | null = null;
    try {
      token = (await activityToken) ?? null;
    } catch {
      // No token to delete.
    }
    if (token === null) {
      return { ok: true, tokens: [] };
    }
    sessionActivityTokens.add(token);
    const authToken = await readUnregisterAuthToken();
    if (authToken === null) {
      return { ok: false, tokens: [token] };
    }
    const failed = await deleteActivityTokens([token], authToken, [sessionActivityTokens]);
    return { ok: failed.length === 0, tokens: failed };
  });
  return result;
}
