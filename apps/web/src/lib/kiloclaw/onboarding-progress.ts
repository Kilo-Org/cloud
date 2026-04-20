import { safeLocalStorage } from '@/lib/localStorage';

/**
 * Marker that the personal KiloClaw onboarding wizard is in progress.
 *
 * This is only a refresh-safety hint: when set, `/claw/new` should keep
 * showing the create-first wizard (identity/permissions/channels) even if
 * billing already reports an active instance. Without this marker, a reload
 * during auto-started provisioning would jump the user to `post-provisioning`
 * (or `complete`) and silently skip identity/permissions/channels input.
 *
 * Scope: personal flow only. Organization onboarding is unchanged.
 */
const CLAW_PERSONAL_ONBOARDING_IN_PROGRESS_KEY = 'kiloclaw-personal-onboarding-in-progress';

export function readPersonalOnboardingInProgress(): boolean {
  return safeLocalStorage.getItem(CLAW_PERSONAL_ONBOARDING_IN_PROGRESS_KEY) === '1';
}

export function markPersonalOnboardingInProgress(): void {
  safeLocalStorage.setItem(CLAW_PERSONAL_ONBOARDING_IN_PROGRESS_KEY, '1');
}

export function clearPersonalOnboardingInProgress(): void {
  safeLocalStorage.removeItem(CLAW_PERSONAL_ONBOARDING_IN_PROGRESS_KEY);
}
