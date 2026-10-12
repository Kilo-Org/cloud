import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  attemptLogoutReconciliation,
  awaitLogoutReconciliationSettled,
  hasPendingActivityUnregister,
} from '@/lib/auth/logout-reconciliation';
import { trpcClient } from '@/lib/trpc';

import { type GlanceableActivity } from './sink-registry';
import { enqueueTokenMutation } from './token-mutation-queue';

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
    await enqueueTokenMutation(async () => {
      if (
        !isCurrent(activityId, registration) ||
        registration.token !== token ||
        registration.registeredToken === token
      ) {
        return;
      }
      sessionActivityTokens.add(token);
      await trpcClient.user.registerActivityToken.mutate({
        token,
        kind: 'ios_session_activity',
        platform: 'ios',
        organizationId: registration.organizationId,
        sessionId: registration.sessionId,
      });
      registration.registeredToken = token;
    });
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

/** Stop observing one card. Its token delete is the caller's (`cleanupTokens('session')`). */
export function releaseSessionActivity(activityId: string): void {
  registrations.get(activityId)?.subscription?.remove();
  registrations.delete(activityId);
}

/** Stop observing every card: the scope is torn down and its tokens are deleted with it. */
export function releaseAllSessionActivities(): void {
  epoch += 1;
  for (const registration of registrations.values()) {
    registration.subscription?.remove();
  }
  registrations.clear();
}

/** Test-only: drop every registration and recorded token. */
export function _resetSessionActivityTokensForTests(): void {
  releaseAllSessionActivities();
  sessionActivityTokens.clear();
}
