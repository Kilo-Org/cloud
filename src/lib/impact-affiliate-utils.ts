export const IMPACT_SIGNUP_FALLBACK_MAX_ACCOUNT_AGE_MS = 30 * 60 * 1000;

export function shouldTrackImpactSignupFallback(params: {
  isNewUser?: boolean;
  hasValidationStytch: boolean | null;
  userCreatedAt: string;
  now?: Date;
}) {
  if (params.isNewUser) return true;
  if (params.hasValidationStytch !== null) return false;

  const createdAtMs = new Date(params.userCreatedAt).getTime();
  if (!Number.isFinite(createdAtMs)) return false;

  const ageMs = (params.now ?? new Date()).getTime() - createdAtMs;
  return ageMs >= 0 && ageMs <= IMPACT_SIGNUP_FALLBACK_MAX_ACCOUNT_AGE_MS;
}
