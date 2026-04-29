/**
 * Pure state machine for the mobile KiloClaw onboarding wizard.
 *
 * The reducer is framework-agnostic. Mobile components consume it via
 * `useReducer(reduce, INITIAL_STATE)` and translate tRPC query / mutation
 * signals and user events into `OnboardingEvent`s.
 *
 * Design notes:
 *
 * - Fire-once analytics guards (`onboardingEnteredFired`, `completionReachedFired`)
 *   live in state, not in component refs. Selectors in `./selectors.ts` combine
 *   these flags with predicates; components dispatch `*-emitted` events after
 *   calling `trackEvent(...)`. This makes "fires exactly once" a directly testable
 *   property of the reducer.
 *
 * - `botIdentitySaved` / `execPresetSaved` gate the step-save mutations
 *   dispatched from `OnboardingFlow`. The reducer flips them on the
 *   `*-saved` ack events; `retry-requested` clears them so the saves re-fire
 *   if the user retries after a provisioning failure. The DO is responsible
 *   for persisting the mutation even if the instance is still `starting`, so
 *   the client fires once per mutation and does not retry on its own —
 *   failure surfaces as a toast from the mutation hook.
 *
 * - The 502-grace sub-machine (`first502AtMs`, `gateway502Expired`) is driven
 *   by `gateway-readiness-changed` events carrying `nowMs` + `gateway-grace-elapsed`
 *   ticks. The pure helper `checkGraceExpired` in `./gateway-502-grace.ts`
 *   lets a component poll on a 1s interval without owning the grace logic.
 *
 * - Resume-at-identity is a property: `INITIAL_STATE.step === 'identity'` and
 *   no event transitions to a later step without first walking through
 *   `identity-submitted` → `channels-skipped` → ... This enforces the
 *   "always re-enter at identity" policy the web client follows.
 *
 * - The tab root stays mounted when the onboarding route is pushed (Expo
 *   Router behavior, verified for this branch), so reducer state survives
 *   step transitions. If that assumption ever breaks, fire-once flags would
 *   reset on re-mount and events would double-fire.
 */

import { type BotIdentity, type ExecPreset, type OnboardingStep } from './shapes';

export type ProvisionErrorCategory = 'access_conflict' | 'generic';

export type OnboardingState = {
  step: OnboardingStep;

  // User selections captured by wizard steps.
  botIdentity: BotIdentity | null;
  weatherLocation: string | null;
  execPreset: ExecPreset | null;

  // Server-observed state (eligibility).
  eligible: boolean;
  hasAccessWithInstance: boolean;
  onboardingStateLoaded: boolean;

  // Provisioning lifecycle.
  provisionStarted: boolean;
  provisionSuccess: boolean;
  sandboxId: string | null;
  errorCategory: ProvisionErrorCategory | null;

  // Instance status polling (post-provision).
  instanceStatus: string | null;

  // Gateway readiness (latest observation).
  gatewayReady: boolean;
  gatewaySettled: boolean;
  gatewayStatus: number | null;

  // Fire-once guards for the step-save mutations dispatched from
  // `OnboardingFlow`. Flipped by the `*-saved` ack events after the
  // corresponding `mutations.patch*.mutate(...)` call — the server mutations
  // are still named `patchBotIdentity` / `patchExecPreset` on the tRPC
  // router. `retry-requested` clears both so a retry after a provisioning
  // failure re-fires them.
  botIdentitySaved: boolean;
  execPresetSaved: boolean;

  // Gateway 502 grace sub-machine.
  first502AtMs: number | null;
  gateway502Expired: boolean;

  // Analytics fire-once guards.
  onboardingEnteredFired: boolean;
  completionReachedFired: boolean;
};

export const INITIAL_STATE: OnboardingState = {
  step: 'identity',
  botIdentity: null,
  weatherLocation: null,
  execPreset: 'never-ask',
  eligible: false,
  hasAccessWithInstance: false,
  onboardingStateLoaded: false,
  provisionStarted: false,
  provisionSuccess: false,
  sandboxId: null,
  errorCategory: null,
  instanceStatus: null,
  gatewayReady: false,
  gatewaySettled: false,
  gatewayStatus: null,
  botIdentitySaved: false,
  execPresetSaved: false,
  first502AtMs: null,
  gateway502Expired: false,
  onboardingEnteredFired: false,
  completionReachedFired: false,
};

export type OnboardingEvent =
  // External signals.
  | {
      type: 'onboarding-state-loaded';
      eligible: boolean;
      hasAccessWithInstance: boolean;
    }
  | { type: 'provision-succeeded'; sandboxId: string }
  | { type: 'provision-failed'; category: ProvisionErrorCategory }
  | { type: 'instance-status-changed'; status: string | null }
  | {
      type: 'gateway-readiness-changed';
      ready: boolean;
      settled: boolean;
      status: number | null;
      nowMs: number;
    }
  | { type: 'gateway-grace-elapsed' }
  | { type: 'bot-identity-saved' }
  | { type: 'exec-preset-saved' }

  // User-initiated events.
  | { type: 'start-requested' }
  | { type: 'identity-submitted'; identity: BotIdentity; weatherLocation?: string | null }
  | { type: 'channels-skipped' }
  | { type: 'provisioning-complete-acknowledged' }
  | { type: 'retry-requested' }
  | { type: 'step-back' }

  // Analytics acks.
  | { type: 'onboarding-entered-emitted' }
  | { type: 'completion-reached-emitted' };

const GATEWAY_502_GRACE_MS = 30_000;

type GatewayReadinessObservation = {
  ready: boolean;
  settled: boolean;
  status: number | null;
  nowMs: number;
};

function reduceGatewayReadiness(
  state: OnboardingState,
  obs: GatewayReadinessObservation
): OnboardingState {
  const is502 = obs.status === 502;
  const firstAt = is502 ? (state.first502AtMs ?? obs.nowMs) : null;
  const expired = firstAt !== null && obs.nowMs - firstAt >= GATEWAY_502_GRACE_MS;

  return {
    ...state,
    gatewayReady: obs.ready,
    gatewaySettled: obs.settled,
    gatewayStatus: obs.status,
    first502AtMs: firstAt,
    gateway502Expired: expired,
  };
}

// eslint-disable-next-line max-lines-per-function -- exhaustive reducer
export function reduce(state: OnboardingState, event: OnboardingEvent): OnboardingState {
  switch (event.type) {
    case 'onboarding-state-loaded': {
      return {
        ...state,
        eligible: event.eligible,
        hasAccessWithInstance: event.hasAccessWithInstance,
        onboardingStateLoaded: true,
      };
    }

    case 'start-requested': {
      return { ...state, errorCategory: null };
    }

    case 'provision-succeeded': {
      return {
        ...state,
        provisionStarted: true,
        provisionSuccess: true,
        sandboxId: event.sandboxId,
        errorCategory: null,
      };
    }

    case 'provision-failed': {
      return { ...state, errorCategory: event.category };
    }

    case 'identity-submitted': {
      // Reset the step-save fire-once guard so a re-submission (e.g. user
      // tapped back from channels and changed the name) re-fires the mutation
      // with the new identity. patchBotIdentity is idempotent, so re-firing
      // with unchanged values is harmless.
      return {
        ...state,
        botIdentity: event.identity,
        weatherLocation: event.weatherLocation ?? null,
        step: 'channels',
        botIdentitySaved: false,
      };
    }

    case 'channels-skipped': {
      return { ...state, step: 'provisioning' };
    }

    case 'bot-identity-saved': {
      return { ...state, botIdentitySaved: true };
    }

    case 'exec-preset-saved': {
      return { ...state, execPresetSaved: true };
    }

    case 'instance-status-changed': {
      return { ...state, instanceStatus: event.status };
    }

    case 'gateway-readiness-changed': {
      return reduceGatewayReadiness(state, event);
    }

    case 'gateway-grace-elapsed': {
      // Poll tick: promote to expired if we've been holding a 502 long enough.
      // nowMs isn't on this event by design — the component passes its own
      // clock via the gateway-readiness-changed stream. The grace helper in
      // `./gateway-502-grace.ts` is the pure predicate that drives this tick.
      if (state.first502AtMs === null) {
        return state;
      }
      return { ...state, gateway502Expired: true };
    }

    case 'provisioning-complete-acknowledged': {
      return { ...state, step: 'done' };
    }

    case 'retry-requested': {
      // Keep provision* / sandboxId (the instance exists) but clear everything
      // that gates step saves and completion so the saves re-fire cleanly.
      // Note: `botIdentity` and `execPreset` are preserved, so the step-save
      // effects will re-fire the mutations on the next render — before the
      // user walks the identity step again. This is intentional: the
      // mutations are idempotent, and the DO instance still exists after a
      // provisioning failure.
      return {
        ...state,
        step: 'identity',
        errorCategory: null,
        botIdentitySaved: false,
        execPresetSaved: false,
        completionReachedFired: false,
        first502AtMs: null,
        gateway502Expired: false,
      };
    }

    case 'step-back': {
      if (state.step === 'channels') {
        return { ...state, step: 'identity' };
      }
      return state;
    }

    case 'onboarding-entered-emitted': {
      return { ...state, onboardingEnteredFired: true };
    }

    case 'completion-reached-emitted': {
      return { ...state, completionReachedFired: true };
    }

    default: {
      const unhandled: never = event;
      throw new Error(`Unhandled onboarding event: ${JSON.stringify(unhandled)}`);
    }
  }
}

export { GATEWAY_502_GRACE_MS };
