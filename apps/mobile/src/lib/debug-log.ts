/**
 * Lightweight debug logs for the kiloclaw onboarding flow.
 *
 * Kept intentionally terse — no identity values, no location strings, no
 * sandboxIds, no raw billing responses. Logs capture the *shape* of progress
 * (step transitions, mutation fire/ok/error, derived billing state kind) so
 * we can debug stuck onboarding without exposing PII to device logs.
 *
 * Scopes: `identity-step`, `billing`, `reducer`, `redirect`,
 * `mutation:provision`, `mutation:patchBotIdentity`, `mutation:patchExecPreset`.
 */

/* eslint-disable no-console -- scoped debug logs for onboarding investigation */

export function debugLog(scope: string, message: string, payload?: unknown): void {
  if (payload === undefined) {
    console.log(`[kc-onboarding][${scope}] ${message}`);
    return;
  }
  try {
    console.log(`[kc-onboarding][${scope}] ${message}`, JSON.stringify(payload));
  } catch {
    console.log(`[kc-onboarding][${scope}] ${message}`, payload);
  }
}
