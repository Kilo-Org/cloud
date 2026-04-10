// Shared parent-domain cookie written by kilo.ai so app.kilo.ai can recover
// the Impact click ID after auth redirects. This is separate from Impact's
// native IR_<campaignId> UTT cookie.
export const IMPACT_CLICK_ID_COOKIE = 'impact_click_id';

// Marker cookie scoped to app.kilo.ai so the app only dedupes against values it
// wrote itself, not against the marketing site's visit-event dedupe marker.
export const IMPACT_APP_TRACKED_CLICK_ID_COOKIE = 'impact_app_tracked_click_id';

export const IMPACT_SIGNUP_FALLBACK_MAX_ACCOUNT_AGE_MS = 30 * 60 * 1000;

export function resolveImpactAffiliateTrackingId(params: {
  imRefParam: string | null;
  sharedImpactCookieValue: string | null;
  appTrackedImpactCookieValue: string | null;
}) {
  const impactCookieValue = params.imRefParam
    ? null
    : params.sharedImpactCookieValue &&
        params.sharedImpactCookieValue !== params.appTrackedImpactCookieValue
      ? params.sharedImpactCookieValue
      : null;

  return {
    affiliateTrackingId: params.imRefParam || impactCookieValue,
    impactCookieValue,
  };
}

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
