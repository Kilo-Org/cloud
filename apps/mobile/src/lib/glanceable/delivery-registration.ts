import { Platform } from 'react-native';

import { addPushToStartTokenListener } from 'expo-widgets';

import { ActiveAgentsLiveActivity } from '@/glanceable-ios/active-agents-live-activity';
import {
  attemptLogoutReconciliation,
  awaitLogoutReconciliationSettled,
} from '@/lib/auth/logout-reconciliation';
import { trpcClient } from '@/lib/trpc';

import { type GlanceableDelivery, setGlanceableDelivery } from './sink-registry';

/**
 * iOS activity-token registrar. Wires the glanceable publisher's delivery
 * hooks to `user.registerActivityToken`/`user.unregisterActivityToken` so the
 * server can reach this device's Live Activity and push-to-start token via
 * APNs. Android uses Expo push tokens and never calls this delivery.
 */

let pushToStartToken: string | null = null;

async function register(
  token: string,
  kind: 'ios_push_to_start' | 'ios_activity',
  organizationId: string | null
): Promise<void> {
  try {
    await trpcClient.user.registerActivityToken.mutate({
      token,
      kind,
      platform: 'ios',
      organizationId,
    });
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

const delivery: GlanceableDelivery = {
  registerTokens(_snapshot, organizationId, userId) {
    if (Platform.OS !== 'ios') {
      return;
    }
    void (async () => {
      // Order against logout cleanup: an in-flight logout unregister for the
      // activity tokens must settle before this session re-registers them, or
      // a later retry could delete this session's rows. Trigger the logout
      // attempt first (it starts a fresh run only when none is running), then
      // await its settle so registration cannot start until any in-flight
      // unregister for this sign-in has settled.
      if (userId !== null) {
        void attemptLogoutReconciliation(userId);
      }
      await awaitLogoutReconciliationSettled();
      if (pushToStartToken !== null) {
        await register(pushToStartToken, 'ios_push_to_start', organizationId);
      }
      try {
        const activity = ActiveAgentsLiveActivity.getInstances().at(-1);
        if (activity) {
          const token = await activity.getPushToken();
          if (token) {
            await register(token, 'ios_activity', organizationId);
          }
        }
      } catch {
        // getInstances can throw on unsupported surfaces; the sink owns retry.
      }
    })();
  },

  async unregisterTokens() {
    if (Platform.OS !== 'ios') {
      return { ok: true, tokens: [] };
    }
    const result = await unregisterActivityTokens();
    return result;
  },
};

/**
 * Gathers the push-to-start token plus the current activity's push token, runs
 * each `unregister(token)` in parallel, and reports success plus every token
 * it attempted. Never rejects: the caller tombstones `tokens` when `ok` is
 * false and retries them at the next authenticated opportunity.
 */
async function unregisterActivityTokens(): Promise<{ ok: boolean; tokens: string[] }> {
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
  if (tokens.length === 0) {
    return { ok: true, tokens };
  }
  const results = await Promise.allSettled(
    tokens.map(async token => {
      const ok = await unregister(token);
      return ok;
    })
  );
  const ok = results.every(result => result.status === 'fulfilled' && result.value);
  return { ok, tokens };
}

setGlanceableDelivery(delivery);
