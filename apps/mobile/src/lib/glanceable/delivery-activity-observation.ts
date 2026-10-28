/**
 * The active Live Activity's push-token observation, split out of
 * `delivery-registration.ts` so each module stays inside the line budget.
 *
 * One observed card per process: the Live Activity the sink registered. The
 * state holder lives in the caller, so this module owns no module-level state
 * and a test can inspect the exact card a call bound.
 */

import { type GlanceableActivity } from './sink-registry';
import { GLANCEABLE_ACTIVITY_TOKEN_KIND, type Registration } from './delivery-registration-types';

export type ActivityObservation = {
  registration: Registration | null;
  instance: GlanceableActivity | null;
  subscription: ReturnType<GlanceableActivity['addPushTokenListener']> | null;
  /** The shared set every observed card's token is recorded in. */
  tokens: Set<string>;
};

/** The empty state one process starts from, over the caller's token set. */
export function emptyActivityObservation(tokens: Set<string>): ActivityObservation {
  return { registration: null, instance: null, subscription: null, tokens };
}

/** Drop the observed card without touching its tokens; the caller keeps those. */
export function detachActivity(observation: ActivityObservation): void {
  observation.registration = null;
  observation.instance = null;
  observation.subscription?.remove();
  observation.subscription = null;
}

/**
 * Observe one Live Activity's update token. A repeated call for the card
 * already observed only re-registers its token; a different card supersedes the
 * old one, whose token the caller retires through `onSuperseded`.
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
    if (observation.instance === instance && observation.registration !== null) {
      if (observation.registration.token !== null) {
        await registerToken(observation.registration, observation.registration.token);
      }
      return;
    }
    if (observation.registration !== null) {
      onSuperseded();
    }
    const registration: Registration = {
      ...target,
      kind: GLANCEABLE_ACTIVITY_TOKEN_KIND,
      token: null,
      registeredToken: null,
      tokens: observation.tokens,
    };
    observation.registration = registration;
    observation.instance = instance;
    observation.subscription = instance.addPushTokenListener(({ pushToken }) => {
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
