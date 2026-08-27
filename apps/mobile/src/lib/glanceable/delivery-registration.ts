import { Platform } from 'react-native';

import { addPushToStartTokenListener } from 'expo-widgets';

import { ActiveAgentsLiveActivity } from '@/glanceable-ios/active-agents-live-activity';
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

async function unregister(token: string): Promise<void> {
  try {
    await trpcClient.user.unregisterActivityToken.mutate({ token });
  } catch {
    // Best effort: a stale token row is pruned server-side.
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
  registerTokens(_snapshot, organizationId) {
    if (Platform.OS !== 'ios') {
      return;
    }
    void (async () => {
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

  unregisterTokens() {
    if (Platform.OS !== 'ios') {
      return;
    }
    void (async () => {
      if (pushToStartToken !== null) {
        await unregister(pushToStartToken);
      }
      try {
        const activity = ActiveAgentsLiveActivity.getInstances().at(-1);
        if (activity) {
          const token = await activity.getPushToken();
          if (token) {
            await unregister(token);
          }
        }
      } catch {
        // Nothing to unregister when no activity survives.
      }
    })();
  },
};

setGlanceableDelivery(delivery);
