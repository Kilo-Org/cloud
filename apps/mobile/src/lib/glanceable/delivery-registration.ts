import { Platform } from 'react-native';

import { addPushToStartTokenListener } from 'expo-widgets';

import { ActiveAgentsLiveActivity } from '@/glanceable-ios/active-agents-live-activity';
import {
  attemptLogoutReconciliation,
  awaitLogoutReconciliationSettled,
  hasPendingActivityUnregister,
} from '@/lib/auth/logout-reconciliation';
import { trpcClient } from '@/lib/trpc';

import { type GlanceableDelivery, setGlanceableDelivery } from './sink-registry';

/**
 * Activity-token registrar. Wires the glanceable publisher's delivery hooks to
 * `user.registerActivityToken`/`user.unregisterActivityToken` so the server can
 * reach this device's surface token: on iOS the Live Activity and push-to-start
 * token via APNs, on Android the per-device Expo push token (`android_ongoing`).
 */

let pushToStartToken: string | null = null;

/** The last Android device token registered, so end/cleanup can unregister it. */
let androidOngoingToken: string | null = null;

/** Epoch bumped on every unregister/end. A register that started before
 * the bump must abort instead of recreating the row after end/logout. */
let registerEpoch = 0;

/** FIFO chain serializing activity-token mutations so the last client intent
 * wins: an upsert and a delete must not race for stable iOS or Android tokens. */
let mutationTail: Promise<void> | null = null;

const NOOP = (): void => undefined;

/** Serialize one mutation; a rejected prior mutation never blocks the next. */
async function enqueueTokenMutation<T>(op: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release: () => void = NOOP;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  mutationTail = gate;
  if (previous !== null) {
    try {
      await previous;
    } catch {
      // A prior mutation failure must not block the next one.
    }
  }
  try {
    return await op();
  } finally {
    release();
  }
}

// Test-only override so pure suites never load @/lib/notifications
// (→ expo-notifications → expo-modules-core → RN).
let getDevicePushTokenForTests: (() => Promise<string | null>) | null = null;

function getDevicePushTokenLazy(): () => Promise<string | null> {
  if (getDevicePushTokenForTests !== null) {
    return getDevicePushTokenForTests;
  }
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  const { getDevicePushToken } = require('@/lib/notifications') as {
    getDevicePushToken: () => Promise<string | null>;
  };
  return getDevicePushToken;
}

async function register(input: {
  token: string;
  kind: 'ios_push_to_start' | 'ios_activity' | 'android_ongoing';
  platform: 'ios' | 'android';
  organizationId: string | null;
}): Promise<void> {
  try {
    await trpcClient.user.registerActivityToken.mutate(input);
  } catch {
    // Best effort: a failed registration is retried on the next start.
  }
}

async function unregister(token: string): Promise<boolean> {
  try {
    await trpcClient.user.unregisterActivityToken.mutate({ token });
    return true;
  } catch {
    // The caller aggregates success and tombstones the token on failure.
    return false;
  }
}

if (Platform.OS === 'ios') {
  // Push-to-start token events are emitted whenever the system rotates the
  // token; cache the latest and register on the next activity start.
  addPushToStartTokenListener(({ activityPushToStartToken }) => {
    pushToStartToken = activityPushToStartToken;
  });
}

/**
 * Android: register the device Expo push token as the `android_ongoing`
 * activity token. The device-token lookup happens outside the mutation chain
 * (the chain must never await logout reconciliation or it can deadlock against
 * `runLogoutCleanup`); only the server mutation and the slot write are
 * serialized, so the last client intent wins even for a stable token.
 */
async function registerAndroidOngoingToken(
  organizationId: string | null,
  userId: string | null
): Promise<void> {
  // Capture the epoch before the first await so an unregister/end that lands
  // during reconciliation or the token lookup aborts this stale register.
  const epoch = registerEpoch;
  if (userId !== null) {
    void attemptLogoutReconciliation(userId);
  }
  try {
    await awaitLogoutReconciliationSettled();
    if (epoch !== registerEpoch) {
      return;
    }
    if (await hasPendingActivityUnregister(userId)) {
      // A pending retry owns the recorded activity tokens; re-registering this
      // device token now would only be deleted by the next attempt.
      return;
    }
    const token = await getDevicePushTokenLazy()();
    if (token === null) {
      return;
    }
    if (epoch !== registerEpoch) {
      return;
    }
    await enqueueTokenMutation(async () => {
      if (epoch !== registerEpoch) {
        return;
      }
      await register({ token, kind: 'android_ongoing', platform: 'android', organizationId });
      androidOngoingToken = token;
    });
  } catch {
    // Best effort: a failed lookup is retried on the next start.
  }
}

/** Android: unregister the recorded device token, tombstoning it on failure.
 * Bumps the epoch (invalidating in-flight registers) and serializes the delete
 * against register so a delete never races an upsert of the same token: the
 * FIFO order decides the final state. */
async function unregisterAndroidOngoingToken(): Promise<{ ok: boolean; tokens: string[] }> {
  registerEpoch += 1;
  const result = enqueueTokenMutation(async () => {
    const token = androidOngoingToken;
    if (token === null) {
      return { ok: true, tokens: [] as string[] };
    }
    const ok = await unregister(token);
    if (ok) {
      androidOngoingToken = null;
    }
    return { ok, tokens: [token] };
  });
  await result;
  return result;
}

const delivery: GlanceableDelivery = {
  registerTokens(_snapshot, organizationId, userId) {
    if (Platform.OS === 'android') {
      void registerAndroidOngoingToken(organizationId, userId);
      return;
    }
    if (Platform.OS !== 'ios') {
      return;
    }
    void (async () => {
      const epoch = registerEpoch;
      // Keep reconciliation and scope-cleanup waits outside the mutation queue:
      // cleanup itself needs that queue to finish its unregister.
      if (userId !== null) {
        void attemptLogoutReconciliation(userId);
      }
      await awaitLogoutReconciliationSettled();
      if ((await hasPendingActivityUnregister(userId)) || epoch !== registerEpoch) {
        return;
      }
      const startToken = pushToStartToken;
      if (startToken !== null) {
        await enqueueTokenMutation(async () => {
          if (epoch !== registerEpoch) {
            return;
          }
          await register({
            token: startToken,
            kind: 'ios_push_to_start',
            platform: 'ios',
            organizationId,
          });
        });
      }
      if (epoch !== registerEpoch) {
        return;
      }
      try {
        const activity = ActiveAgentsLiveActivity.getInstances().at(-1);
        if (activity) {
          const token = await activity.getPushToken();
          if (token) {
            await enqueueTokenMutation(async () => {
              if (epoch !== registerEpoch) {
                return;
              }
              await register({ token, kind: 'ios_activity', platform: 'ios', organizationId });
            });
          }
        }
      } catch {
        // getInstances can throw on unsupported surfaces; the sink owns retry.
      }
    })();
  },

  async unregisterTokens() {
    if (Platform.OS === 'android') {
      return unregisterAndroidOngoingToken();
    }
    if (Platform.OS !== 'ios') {
      return { ok: true, tokens: [] };
    }
    registerEpoch += 1;
    const tokens = collectIosActivityTokens();
    const result = await enqueueTokenMutation(async () => unregisterActivityTokens(await tokens));
    return result;
  },
};

/** Capture the current iOS tokens before a later scope replaces the native instance. */
async function collectIosActivityTokens(): Promise<string[]> {
  const tokens: string[] = [];
  if (pushToStartToken !== null) {
    tokens.push(pushToStartToken);
  }
  try {
    const activity = ActiveAgentsLiveActivity.getInstances().at(-1);
    if (activity) {
      const token = await activity.getPushToken();
      if (token) {
        tokens.push(token);
      }
    }
  } catch {
    // Nothing to unregister when no activity survives.
  }
  return tokens;
}

/**
 * Unregister the captured iOS tokens in parallel and report only failures.
 * The caller tombstones those tokens, so a retry never re-deletes a token
 * that already succeeded and can belong to the new session.
 */
async function unregisterActivityTokens(
  tokens: string[]
): Promise<{ ok: boolean; tokens: string[] }> {
  if (tokens.length === 0) {
    return { ok: true, tokens };
  }
  const results = await Promise.allSettled(
    tokens.map(async token => {
      const ok = await unregister(token);
      return ok;
    })
  );
  const failedTokens = tokens.filter((_token, index) => {
    const result = results[index];
    return result === undefined || result.status === 'rejected' || !result.value;
  });
  return { ok: failedTokens.length === 0, tokens: failedTokens };
}

setGlanceableDelivery(delivery);

// ── Test-only helpers ──────────────────────────────────────────────────────

export function _setGetDevicePushTokenForTests(fn: (() => Promise<string | null>) | null): void {
  getDevicePushTokenForTests = fn;
}

export function _resetDeliveryRegistrationForTests(): void {
  androidOngoingToken = null;
  pushToStartToken = null;
  registerEpoch += 1;
  mutationTail = null;
}
