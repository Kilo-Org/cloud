/**
 * The active Live Activity's push-token observation, split out of
 * `delivery-registration.ts` so each module stays inside the line budget.
 *
 * One observed card per process: the Live Activity the sink registered. The
 * state holder lives in the caller, so this module owns no module-level state
 * and a test can inspect the exact card a call bound.
 */

import { type EventSubscription } from 'expo';

import { type GlanceableActivity } from './sink-registry';
import { GLANCEABLE_ACTIVITY_TOKEN_KIND, type Registration } from './delivery-registration-types';

/**
 * One observed Live Activity: its registration, the card it belongs to, and the
 * listener that feeds it. All three are created together or not at all, so a card
 * is either observed or unobserved — never recorded without its listener.
 */
export type ActivityBinding = {
  readonly registration: Registration;
  readonly instance: GlanceableActivity;
  readonly subscription: EventSubscription;
};

export type ActivityObservation = {
  /** The shared set every observed card's token is recorded in. */
  readonly tokens: Set<string>;
  /** Non-null only while the card, its registration and its listener are all live. */
  binding: ActivityBinding | null;
};

/** The empty state one process starts from, over the caller's token set. */
export function emptyActivityObservation(tokens: Set<string>): ActivityObservation {
  return { tokens, binding: null };
}

/** Drop the observed card without touching its tokens; the caller keeps those. */
export function detachActivity(observation: ActivityObservation): void {
  observation.binding?.subscription.remove();
  observation.binding = null;
}

/**
 * Register the card's token, reading it from the card when no token event arrived yet.
 * A repeated observe takes this path too, so a read that failed is retried.
 */
async function syncActivityToken(
  binding: ActivityBinding,
  registerToken: (registration: Registration, token: string) => Promise<void>
): Promise<void> {
  const { registration, instance } = binding;
  if (registration.token !== null) {
    await registerToken(registration, registration.token);
    return;
  }
  const token = await instance.getPushToken();
  // A token event is newer than the initial asynchronous read.
  if (token !== null && registration.token === null) {
    await registerToken(registration, token);
  }
}

/**
 * Observe one Live Activity's update token. A repeated call for the card
 * already observed only syncs its token; a different card supersedes the old
 * one, whose token the caller retires through `onSuperseded`.
 */
export async function observeActivity(params: {
  observation: ActivityObservation;
  target: Registration;
  instance: GlanceableActivity;
  /** Retire the superseded card's token; the caller owns that cleanup. */
  onSuperseded: () => void;
  registerToken: (registration: Registration, token: string) => Promise<void>;
}): Promise<void> {
  const { observation, target, instance, onSuperseded, registerToken } = params;
  try {
    const existing = observation.binding;
    if (existing !== null && existing.instance === instance) {
      await syncActivityToken(existing, registerToken);
      return;
    }
    if (existing !== null) {
      onSuperseded();
      detachActivity(observation);
    }
    const registration: Registration = {
      ...target,
      kind: GLANCEABLE_ACTIVITY_TOKEN_KIND,
      token: null,
      registeredToken: null,
      tokens: observation.tokens,
    };
    // The listener is created before the binding is recorded: a throw here leaves
    // the card unobserved, so the next refresh binds it instead of trusting a
    // registration that nothing feeds.
    const subscription = instance.addPushTokenListener(({ pushToken }) => {
      void registerToken(registration, pushToken);
    });
    const binding: ActivityBinding = { registration, instance, subscription };
    observation.binding = binding;
    await syncActivityToken(binding, registerToken);
  } catch {
    // Unsupported or transient native reads must not discard the scope subscription.
  }
}

/** Read a card's push token, or null when the native read fails. */
export async function collectActivityToken(
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
