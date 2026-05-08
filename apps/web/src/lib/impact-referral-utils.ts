export const IMPACT_OPAQUE_TRACKING_VALUE_MAX_LENGTH = 512;
export const IMPACT_REFERRAL_TOUCH_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
export const IMPACT_CUSTOM_PROFILE_ID_STORAGE_KEY = 'impact_custom_profile_id';

export type SanitizedOpaqueTrackingValue = {
  acceptedValue: string | null;
  originalLength: number;
  isAccepted: boolean;
};

export type ParsedImpactReferralTouch = {
  opaqueTrackingValue: string | null;
  trackingValueLength: number;
  isTrackingValueAccepted: boolean;
  rsCode: string | null;
  rsShareMedium: string | null;
  rsEngagementMedium: string | null;
  landingPath: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  touchedAt: Date;
  expiresAt: Date;
};

export type ParsedImpactAffiliateTouch = {
  trackingId: string | null;
  trackingValueLength: number;
  isTrackingValueAccepted: boolean;
  landingPath: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  touchedAt: Date;
  expiresAt: Date;
};

function normalizeInput(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function sanitizeMetadataValue(value: string | null | undefined): string | null {
  const normalized = normalizeInput(value);
  if (!normalized || normalized.length > IMPACT_OPAQUE_TRACKING_VALUE_MAX_LENGTH) {
    return null;
  }
  return normalized;
}

function landingPathFromUrl(url: URL): string | null {
  const path = `${url.pathname}${url.search}`.trim();
  return path ? path : null;
}

export function sanitizeOpaqueTrackingValue(
  value: string | null | undefined
): SanitizedOpaqueTrackingValue {
  const normalized = normalizeInput(value);
  const originalLength = normalized?.length ?? 0;

  if (!normalized) {
    return {
      acceptedValue: null,
      originalLength,
      isAccepted: false,
    };
  }

  if (normalized.length > IMPACT_OPAQUE_TRACKING_VALUE_MAX_LENGTH) {
    return {
      acceptedValue: null,
      originalLength,
      isAccepted: false,
    };
  }

  return {
    acceptedValue: normalized,
    originalLength,
    isAccepted: true,
  };
}

export function redactOpaqueTrackingValueForLogs(value: string | null | undefined): string | null {
  const normalized = normalizeInput(value);
  if (!normalized) return null;

  if (normalized.length <= 8) {
    return '[redacted]';
  }

  return `${normalized.slice(0, 4)}…${normalized.slice(-4)}`;
}

export function redactLandingPathForLogs(value: string | null | undefined): string | null {
  const normalized = normalizeInput(value);
  if (!normalized) return null;

  try {
    const url = new URL(normalized, 'http://localhost');
    const redactedSearchParams = new URLSearchParams();
    for (const [key] of url.searchParams) {
      redactedSearchParams.append(key, 'redacted');
    }
    const search = redactedSearchParams.toString();
    return `${url.pathname}${search ? `?${search}` : ''}`;
  } catch {
    return '[redacted: invalid landing path]';
  }
}

export function parseImpactReferralTouchFromUrl(
  candidateUrl: string | URL,
  now: Date = new Date()
): ParsedImpactReferralTouch | null {
  const url =
    typeof candidateUrl === 'string' ? new URL(candidateUrl, 'http://localhost') : candidateUrl;
  const searchParams = url.searchParams;

  const hasReferralSignals = ['_saasquatch', 'rsCode', 'rsShareMedium', 'rsEngagementMedium'].some(
    key => normalizeInput(searchParams.get(key))
  );

  if (!hasReferralSignals) {
    return null;
  }

  const trackingValue = sanitizeOpaqueTrackingValue(searchParams.get('_saasquatch'));

  return {
    opaqueTrackingValue: trackingValue.acceptedValue,
    trackingValueLength: trackingValue.originalLength,
    isTrackingValueAccepted: trackingValue.isAccepted,
    rsCode: sanitizeMetadataValue(searchParams.get('rsCode')),
    rsShareMedium: sanitizeMetadataValue(searchParams.get('rsShareMedium')),
    rsEngagementMedium: sanitizeMetadataValue(searchParams.get('rsEngagementMedium')),
    landingPath: landingPathFromUrl(url),
    utmSource: sanitizeMetadataValue(searchParams.get('utm_source')),
    utmMedium: sanitizeMetadataValue(searchParams.get('utm_medium')),
    utmCampaign: sanitizeMetadataValue(searchParams.get('utm_campaign')),
    utmTerm: sanitizeMetadataValue(searchParams.get('utm_term')),
    utmContent: sanitizeMetadataValue(searchParams.get('utm_content')),
    touchedAt: now,
    expiresAt: new Date(now.getTime() + IMPACT_REFERRAL_TOUCH_VALIDITY_MS),
  };
}

export function parseImpactAffiliateTouchFromUrl(
  candidateUrl: string | URL,
  trackingIdOverride?: string | null,
  now: Date = new Date()
): ParsedImpactAffiliateTouch | null {
  const url =
    typeof candidateUrl === 'string' ? new URL(candidateUrl, 'http://localhost') : candidateUrl;
  const searchParams = url.searchParams;
  const trackingValue = sanitizeOpaqueTrackingValue(
    trackingIdOverride ?? searchParams.get('im_ref')
  );

  if (!trackingValue.acceptedValue && trackingValue.originalLength === 0) {
    return null;
  }

  return {
    trackingId: trackingValue.acceptedValue,
    trackingValueLength: trackingValue.originalLength,
    isTrackingValueAccepted: trackingValue.isAccepted,
    landingPath: landingPathFromUrl(url),
    utmSource: sanitizeMetadataValue(searchParams.get('utm_source')),
    utmMedium: sanitizeMetadataValue(searchParams.get('utm_medium')),
    utmCampaign: sanitizeMetadataValue(searchParams.get('utm_campaign')),
    utmTerm: sanitizeMetadataValue(searchParams.get('utm_term')),
    utmContent: sanitizeMetadataValue(searchParams.get('utm_content')),
    touchedAt: now,
    expiresAt: new Date(now.getTime() + IMPACT_REFERRAL_TOUCH_VALIDITY_MS),
  };
}
