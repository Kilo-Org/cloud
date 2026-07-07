import { describe, expect, it } from 'vitest';

import { shouldStartAnalytics } from './analytics-consent';

describe('Analytics consent gate', () => {
  it('does not start before consent is checked and accepted', () => {
    expect(
      shouldStartAnalytics({
        hasToken: true,
        consentChecked: false,
        needsConsent: false,
      })
    ).toBe(false);
    expect(
      shouldStartAnalytics({
        hasToken: true,
        consentChecked: true,
        needsConsent: true,
      })
    ).toBe(false);
  });

  it('starts only for signed-in users with accepted consent', () => {
    expect(
      shouldStartAnalytics({
        hasToken: false,
        consentChecked: true,
        needsConsent: false,
      })
    ).toBe(false);
    expect(
      shouldStartAnalytics({
        hasToken: true,
        consentChecked: true,
        needsConsent: false,
      })
    ).toBe(true);
  });
});
