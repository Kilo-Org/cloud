import { describe, expect, it } from '@jest/globals';
import {
  IMPACT_OPAQUE_TRACKING_VALUE_MAX_LENGTH,
  IMPACT_REFERRAL_TOUCH_VALIDITY_MS,
  parseImpactAffiliateTouchFromUrl,
  parseImpactReferralTouchFromUrl,
  redactLandingPathForLogs,
  redactOpaqueTrackingValueForLogs,
  sanitizeOpaqueTrackingValue,
} from '@/lib/impact/referral-utils';

describe('impact referral utils', () => {
  it('accepts opaque tracking values within the configured limit', () => {
    expect(sanitizeOpaqueTrackingValue('abc123')).toEqual({
      acceptedValue: 'abc123',
      originalLength: 6,
      isAccepted: true,
    });
  });

  it('rejects opaque tracking values above the configured limit', () => {
    const tooLongValue = 'x'.repeat(IMPACT_OPAQUE_TRACKING_VALUE_MAX_LENGTH + 1);
    expect(sanitizeOpaqueTrackingValue(tooLongValue)).toEqual({
      acceptedValue: null,
      originalLength: tooLongValue.length,
      isAccepted: false,
    });
  });

  it('redacts opaque tracking values for logs without exposing the full value', () => {
    expect(redactOpaqueTrackingValueForLogs('abcd1234wxyz5678')).toBe('abcd…5678');
    expect(redactOpaqueTrackingValueForLogs('tiny')).toBe('[redacted]');
    expect(redactOpaqueTrackingValueForLogs(null)).toBeNull();
  });

  it('redacts landing path query values for logs', () => {
    expect(
      redactLandingPathForLogs('/get-started?_saasquatch=sq-cookie&rsCode=abc&utm_campaign=launch')
    ).toBe('/get-started?_saasquatch=redacted&rsCode=redacted&utm_campaign=redacted');
    expect(redactLandingPathForLogs('/get-started')).toBe('/get-started');
    expect(redactLandingPathForLogs(null)).toBeNull();
  });

  it('parses referral touches and applies a 30 day expiry window', () => {
    const now = new Date('2026-04-23T10:00:00.000Z');
    const touch = parseImpactReferralTouchFromUrl(
      'https://kilo.ai/get-started?_saasquatch=sq-cookie&rsCode=abc&rsShareMedium=email&rsEngagementMedium=link&utm_source=impact',
      now
    );

    expect(touch).toEqual({
      opaqueTrackingValue: 'sq-cookie',
      trackingValueLength: 9,
      isTrackingValueAccepted: true,
      rsCode: 'abc',
      rsShareMedium: 'email',
      rsEngagementMedium: 'link',
      landingPath:
        '/get-started?_saasquatch=sq-cookie&rsCode=abc&rsShareMedium=email&rsEngagementMedium=link&utm_source=impact',
      utmSource: 'impact',
      utmMedium: null,
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
      touchedAt: now,
      expiresAt: new Date(now.getTime() + IMPACT_REFERRAL_TOUCH_VALIDITY_MS),
    });
  });

  it('keeps referral metadata for diagnostics when _saasquatch is missing', () => {
    const touch = parseImpactReferralTouchFromUrl(
      'https://kilo.ai/get-started?rsCode=abc&rsShareMedium=email'
    );

    expect(touch?.opaqueTrackingValue).toBeNull();
    expect(touch?.trackingValueLength).toBe(0);
    expect(touch?.isTrackingValueAccepted).toBe(false);
    expect(touch?.rsCode).toBe('abc');
  });

  it('parses affiliate touches from im_ref and override cookies', () => {
    const fromQuery = parseImpactAffiliateTouchFromUrl('https://kilo.ai/?im_ref=impact-click');
    expect(fromQuery?.trackingId).toBe('impact-click');

    const fromCookie = parseImpactAffiliateTouchFromUrl('https://kilo.ai/', 'impact-cookie-click');
    expect(fromCookie?.trackingId).toBe('impact-cookie-click');
  });
});
