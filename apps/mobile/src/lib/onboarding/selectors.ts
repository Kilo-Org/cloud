/**
 * Pure selectors over `OnboardingState`.
 *
 * Selectors are the single source of truth for analytics fire-once rules and
 * transition predicates. Components call selectors during render, fire the
 * associated side effect (`trackEvent`, navigation, mutation), and dispatch
 * the corresponding `*-emitted` or `*-dispatched` event. The ack flips the
 * fire-once flag in state, so the selector returns `false` on subsequent
 * renders.
 */

import { type OnboardingState } from './machine';

/**
 * Fire `onboarding-entered` once per session, only for users who will
 * actually see the wizard. Exclude users who are about to be redirected out
 * (has_access with an existing instance).
 */
export function shouldFireOnboardingEntered(state: OnboardingState): boolean {
  return (
    state.onboardingStateLoaded &&
    state.eligible &&
    !state.hasAccessWithInstance &&
    !state.onboardingEnteredFired
  );
}

/**
 * Fire `completion-reached` exactly once when the full gate is satisfied:
 * - provision succeeded
 * - instance running
 * - gateway ready AND settled
 *
 * Step saves fire earlier (via `shouldSave*` selectors) and their server-side
 * apply is handled by the DO's pending-flush hook, so client-side
 * config-applied tracking is no longer part of the completion gate.
 */
export function shouldFireCompletion(state: OnboardingState): boolean {
  return (
    state.provisionSuccess &&
    state.instanceStatus === 'running' &&
    state.gatewayReady &&
    state.gatewaySettled &&
    !state.completionReachedFired
  );
}

/**
 * Whether the bot identity should be saved to the instance now.
 *
 * Gated on `provisionSuccess` so the mutation never races the `provision`
 * call's own resolve (the instance row must exist before the router can look
 * it up). Gated on `botIdentity !== null` so we only fire after the user has
 * committed to the identity step.
 */
export function shouldSaveBotIdentity(state: OnboardingState): boolean {
  return state.provisionSuccess && state.botIdentity !== null && !state.botIdentitySaved;
}

/**
 * Whether the exec preset should be saved to the instance now.
 *
 * On mobile the preset defaults to `'never-ask'` and there is no wizard step
 * to change it, so the save is effectively "fire once after provision
 * succeeds and the user has committed to the identity step". We still gate on
 * the preset being non-null and not `'always-ask'` to mirror the semantics of
 * the (now-removed) `planPatches` helper: `'always-ask'` matches the openclaw
 * default and requires no save.
 */
export function shouldSaveExecPreset(state: OnboardingState): boolean {
  return (
    state.provisionSuccess &&
    state.botIdentity !== null &&
    state.execPreset !== null &&
    state.execPreset !== 'always-ask' &&
    !state.execPresetSaved
  );
}

/**
 * Whether the provisioning step should advance to its completion acknowledgement.
 *
 * This used to gate on a client-side `configApplied` signal, but the step
 * saves have moved that apply responsibility into the DO (see PR 1). The
 * client now only waits for the instance + gateway signals; the DO flushes
 * any pending config on the `starting → running` transition.
 */
export function shouldAdvanceFromProvisioning(state: OnboardingState): boolean {
  return state.instanceStatus === 'running' && state.gatewayReady && state.gatewaySettled;
}

/**
 * Instance lifecycle statuses that mean provisioning cannot proceed
 * automatically. Mirrors the web onboarding wizard's
 * `CLAW_ONBOARDING_ERROR_STATUSES` (`stopped`). Mobile's `InstanceStatus`
 * type has no `crashed` value today; add it here if the backend introduces
 * one.
 */
const TERMINAL_INSTANCE_STATUSES = new Set(['stopped']);

export type ProvisioningTerminalReason =
  | 'query_error'
  | 'instance_stopped'
  | 'gateway_502'
  | 'timeout';

/**
 * Why (if at all) the provisioning step should render its terminal view,
 * in priority order: a hard query error outranks a stopped instance, which
 * outranks the 502-grace timer, which outranks the overall wall-clock
 * timeout. Returns `null` while provisioning is still progressing normally.
 *
 * `timedOut` is passed in rather than read from `state` because the overall
 * wall-clock timeout has no other producer/consumer than `ProvisioningStep`,
 * which tracks it as local `useState` instead of a machine round-trip.
 */
export function getProvisioningTerminalReason(
  state: OnboardingState,
  timedOut: boolean
): ProvisioningTerminalReason | null {
  if (state.queryErrored) {
    return 'query_error';
  }
  if (state.instanceStatus !== null && TERMINAL_INSTANCE_STATUSES.has(state.instanceStatus)) {
    return 'instance_stopped';
  }
  if (state.gateway502Expired) {
    return 'gateway_502';
  }
  if (timedOut) {
    return 'timeout';
  }
  return null;
}

/**
 * Whether the provisioning step should render its terminal "Provisioning failed"
 * view. True iff `getProvisioningTerminalReason` finds a terminal cause.
 */
export function isProvisioningTerminal(state: OnboardingState, timedOut: boolean): boolean {
  return getProvisioningTerminalReason(state, timedOut) !== null;
}
