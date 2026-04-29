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
 * Whether the provisioning step should render its terminal "Provisioning failed"
 * view. True iff the 30s 502 grace window has elapsed.
 */
export function isProvisioningTerminal(state: OnboardingState): boolean {
  return state.gateway502Expired;
}
