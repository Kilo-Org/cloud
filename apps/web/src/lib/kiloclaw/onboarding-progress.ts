import { safeSessionStorage } from '@/lib/localStorage';

/**
 * Marker that the personal KiloClaw onboarding wizard is in progress.
 *
 * This is only a refresh-safety hint: when set, `/claw/new` should keep
 * showing the create-first wizard (identity/permissions/channels) even if
 * billing already reports an active instance. Without this marker, a reload
 * during auto-started provisioning would jump the user to `post-provisioning`
 * (or `complete`) and silently skip identity/permissions/channels input.
 *
 * This marker is intentionally session-scoped so stale progress does not leak
 * across account switches or browser restarts.
 *
 * Scope: personal flow only. Organization onboarding is unchanged.
 */
const CLAW_PERSONAL_ONBOARDING_IN_PROGRESS_KEY = 'kiloclaw-personal-onboarding-in-progress';

export function readPersonalOnboardingInProgress(): boolean {
  return safeSessionStorage.getItem(CLAW_PERSONAL_ONBOARDING_IN_PROGRESS_KEY) === '1';
}

export function markPersonalOnboardingInProgress(): void {
  safeSessionStorage.setItem(CLAW_PERSONAL_ONBOARDING_IN_PROGRESS_KEY, '1');
}

export function clearPersonalOnboardingInProgress(): void {
  safeSessionStorage.removeItem(CLAW_PERSONAL_ONBOARDING_IN_PROGRESS_KEY);
}
