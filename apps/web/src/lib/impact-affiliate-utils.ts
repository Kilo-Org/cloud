// Shared parent-domain cookie written by kilo.ai so app.kilo.ai can recover
// the Impact click ID after auth redirects. This is separate from Impact's
// native IR_<campaignId> UTT cookie.
export const IMPACT_CLICK_ID_COOKIE = 'impact_click_id';

// Marker cookie scoped to the app so we only run the fallback capture path once
// after recovering the click ID from the shared parent-domain cookie.
export const IMPACT_TRACKED_CLICK_ID_COOKIE = 'impact_tracked_click_id';

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
