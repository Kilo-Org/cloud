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
 * This marker is intentionally session-scoped and user-scoped so stale
 * progress does not leak across account switches or browser restarts.
 *
 * Scope: personal flow only. Organization onboarding is unchanged.
 */
const CLAW_PERSONAL_ONBOARDING_IN_PROGRESS_KEY = 'kiloclaw-personal-onboarding-in-progress';

function getPersonalOnboardingInProgressKey(userId: string): string {
  return `${CLAW_PERSONAL_ONBOARDING_IN_PROGRESS_KEY}:${userId}`;
}

export function readPersonalOnboardingInProgress(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return safeSessionStorage.getItem(getPersonalOnboardingInProgressKey(userId)) === '1';
}

export function markPersonalOnboardingInProgress(userId: string | null | undefined): void {
  if (!userId) return;
  safeSessionStorage.setItem(getPersonalOnboardingInProgressKey(userId), '1');
}

export function clearPersonalOnboardingInProgress(userId: string | null | undefined): void {
  if (!userId) return;
  safeSessionStorage.removeItem(getPersonalOnboardingInProgressKey(userId));
}
