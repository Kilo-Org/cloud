import { Platform } from 'react-native';

import { addPushToStartTokenListener } from 'expo-widgets';

import { ActiveAgentsLiveActivity } from '@/glanceable-ios/active-agents-live-activity';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { unregisterActivityTokensAndTombstone } from '@/lib/auth/logout-cleanup';
import {
  attemptLogoutReconciliation,
  awaitLogoutReconciliationSettled,
  hasPendingActivityUnregister,
} from '@/lib/auth/logout-reconciliation';
import { trpcClient } from '@/lib/trpc';

import { enqueueTokenMutation, resetTokenMutationQueue } from './token-mutation-queue';

import { canRegisterActivityTokenKind } from './live-activity-switch';
import {
  type GlanceableActivity,
  type GlanceableDelivery,
  type GlanceableSinkContext,
  setGlanceableDelivery,
} from './sink-registry';

/** Scope delivery survives idle work; only the activity registration ends with its surface. */
type Registration = GlanceableSinkContext & {
  kind: 'ios_push_to_start' | 'ios_activity' | 'android_ongoing';
  epoch: number;
  authEpoch: number;
  token: string | null;
  registeredToken: string | null;
  tokens: Set<string>;
};

let pushToStartToken: string | null = null;
let scopeRegistration: Registration | null = null;
let activityRegistration: Registration | null = null;
let observedActivity: GlanceableActivity | null = null;
let startSubscription: ReturnType<typeof addPushToStartTokenListener> | null = null;
let activitySubscription: ReturnType<GlanceableActivity['addPushTokenListener']> | null = null;
// Keep every attempted token until its delete succeeds, including tokens rotated away by native.
const scopeTokens = new Set<string>();
const activityTokens = new Set<string>();
let registerEpoch = 0;

// Pure suites must not load the native notification graph.
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

function isCurrent(target: Registration): boolean {
  return (
    target.epoch === registerEpoch &&
    isCurrentAuthEpoch(target.authEpoch) &&
    (target === scopeRegistration || target === activityRegistration)
  );
}

async function canRegister(target: Registration): Promise<boolean> {
  if (!isCurrent(target)) {
    return false;
  }
  // Never wait for cleanup inside the mutation queue: cleanup needs that queue itself.
  if (target.userId !== null) {
    void attemptLogoutReconciliation(target.userId);
  }
  await awaitLogoutReconciliationSettled();
  return (
    isCurrent(target) && !(await hasPendingActivityUnregister(target.userId)) && isCurrent(target)
  );
}

async function registerToken(target: Registration, token: string): Promise<void> {
  if (!isCurrent(target) || !token || !canRegisterActivityTokenKind(target.kind)) {
    return;
  }
  target.token = token;
  if (target.registeredToken === token) {
    return;
  }
  try {
    if (!(await canRegister(target))) {
      return;
    }
    await enqueueTokenMutation(async () => {
      if (!isCurrent(target) || target.token !== token || target.registeredToken === token) {
        return;
      }
      target.tokens.add(token);
      await trpcClient.user.registerActivityToken.mutate({
        token,
        kind: target.kind,
        platform: target.kind === 'android_ongoing' ? 'android' : 'ios',
        organizationId: target.organizationId,
      });
      target.registeredToken = token;
    });
  } catch {
    // Retry on the next token event or scope refresh; an uncertain upsert still needs cleanup.
  }
}

function observePushToStart(target: Registration | null): void {
  startSubscription?.remove();
  const epoch = registerEpoch;
  startSubscription = addPushToStartTokenListener(({ activityPushToStartToken }) => {
    if (epoch !== registerEpoch || (target !== null && !isCurrent(target))) {
      return;
    }
    pushToStartToken = activityPushToStartToken;
    if (target !== null) {
      void registerToken(target, activityPushToStartToken);
    }
  });
}

function detachActivity(): void {
  activityRegistration = null;
  observedActivity = null;
  activitySubscription?.remove();
  activitySubscription = null;
}

function getScope(organizationId: string | null, userId: string | null): Registration {
  if (
    scopeRegistration === null ||
    scopeRegistration.organizationId !== organizationId ||
    scopeRegistration.userId !== userId ||
    !isCurrent(scopeRegistration)
  ) {
    registerEpoch += 1;
    detachActivity();
    scopeRegistration = {
      organizationId,
      userId,
      kind: Platform.OS === 'android' ? 'android_ongoing' : 'ios_push_to_start',
      epoch: registerEpoch,
      authEpoch: currentAuthEpoch(),
      token: null,
      registeredToken: null,
      tokens: scopeTokens,
    };
    if (Platform.OS === 'ios') {
      observePushToStart(scopeRegistration);
    }
  }
  return scopeRegistration;
}

async function registerAndroidToken(target: Registration): Promise<void> {
  try {
    if (target.registeredToken !== null || !(await canRegister(target))) {
      return;
    }
    const token = await getDevicePushTokenLazy()();
    if (token !== null) {
      await registerToken(target, token);
    }
  } catch {
    // A failed lookup retries on the next authorized scope refresh.
  }
}

async function observeActivity(target: Registration, instance: GlanceableActivity): Promise<void> {
  try {
    if (observedActivity === instance && activityRegistration !== null) {
      if (activityRegistration.token !== null) {
        await registerToken(activityRegistration, activityRegistration.token);
      }
      return;
    }
    if (activityRegistration !== null) {
      delivery.cleanupTokens('activity');
    }
    const registration: Registration = {
      ...target,
      kind: 'ios_activity',
      token: null,
      registeredToken: null,
      tokens: activityTokens,
    };
    activityRegistration = registration;
    observedActivity = instance;
    activitySubscription = instance.addPushTokenListener(({ pushToken }) => {
      void registerToken(registration, pushToken);
    });
    const token = await instance.getPushToken();
    // A token event is newer than the initial asynchronous read.
    if (token !== null && registration.token === null) {
      await registerToken(registration, token);
    }
  } catch {
    // Unsupported or transient native reads must not discard the scope subscription.
  }
}

async function collectActivityToken(
  instance: GlanceableActivity | null,
  activityToken?: Promise<string | null>
): Promise<string | null> {
  try {
    return (await (activityToken ?? instance?.getPushToken())) ?? null;
  } catch {
    // Recorded tokens still need deletion when a native read fails.
    return null;
  }
}

const delivery: GlanceableDelivery = {
  registerScopeTokens(organizationId, userId) {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
      return;
    }
    const target = getScope(organizationId, userId);
    if (Platform.OS === 'android') {
      void registerAndroidToken(target);
    } else if (pushToStartToken !== null) {
      void registerToken(target, pushToStartToken);
    }
  },

  // eslint-disable-next-line max-params -- preserve the existing delivery arguments and pass the sink's stable native handle
  registerTokens(_snapshot, organizationId, userId, instance) {
    delivery.registerScopeTokens(organizationId, userId);
    if (Platform.OS !== 'ios' || scopeRegistration === null) {
      return;
    }
    try {
      const current = instance ?? ActiveAgentsLiveActivity.getInstances().at(-1);
      if (current) {
        void observeActivity(scopeRegistration, current);
      }
    } catch {
      // getInstances can throw on unsupported surfaces; the sink owns retry.
    }
  },

  cleanupTokens(lifetime, activityToken) {
    void unregisterActivityTokensAndTombstone(lifetime, activityToken);
  },

  async unregisterTokens(lifetime, activityToken) {
    const includeScope = lifetime !== 'activity';
    let instance = observedActivity;
    if (Platform.OS === 'ios' && instance === null && activityToken === undefined) {
      try {
        instance = ActiveAgentsLiveActivity.getInstances().at(-1) ?? null;
      } catch {
        // Recorded tokens remain available when native discovery fails.
      }
    }
    if (includeScope) {
      registerEpoch += 1;
      scopeRegistration = null;
      if (Platform.OS === 'ios') {
        if (pushToStartToken !== null) {
          scopeTokens.add(pushToStartToken);
        }
        observePushToStart(null);
      }
    }
    detachActivity();
    const nativeToken = collectActivityToken(instance, activityToken);
    const result = await enqueueTokenMutation(async () => {
      const capturedToken = await nativeToken;
      if (capturedToken) {
        activityTokens.add(capturedToken);
      }
      // Read the sets inside the FIFO so an already-running upsert is included.
      const tokens = [
        ...new Set(includeScope ? [...scopeTokens, ...activityTokens] : activityTokens),
      ];
      const results = await Promise.all(
        tokens.map(async token => {
          try {
            await trpcClient.user.unregisterActivityToken.mutate({ token });
            scopeTokens.delete(token);
            activityTokens.delete(token);
            return true;
          } catch {
            return false;
          }
        })
      );
      const failed = tokens.filter((_token, index) => !results[index]);
      // Keep Android's existing successful-cleanup result contract.
      return {
        ok: failed.length === 0,
        tokens: Platform.OS === 'android' && failed.length === 0 ? tokens : failed,
      };
    });
    return result;
  },
};

if (Platform.OS === 'ios') {
  // Cache early tokens without registering an unauthenticated scope.
  observePushToStart(null);
}
setGlanceableDelivery(delivery);

export function _setGetDevicePushTokenForTests(fn: (() => Promise<string | null>) | null): void {
  getDevicePushTokenForTests = fn;
}

export function _resetDeliveryRegistrationForTests(): void {
  registerEpoch += 1;
  detachActivity();
  scopeRegistration = null;
  scopeTokens.clear();
  activityTokens.clear();
  pushToStartToken = null;
  resetTokenMutationQueue();
  if (Platform.OS === 'ios') {
    observePushToStart(null);
  }
}
