import { describe, expect, it } from 'vitest';

import { shouldStartAppsFlyer } from './appsflyer-consent';

describe('AppsFlyer consent gate', () => {
  it('does not start before consent is checked and accepted', () => {
    expect(
      shouldStartAppsFlyer({
        hasToken: true,
        consentChecked: false,
        needsConsent: false,
      })
    ).toBe(false);
    expect(
      shouldStartAppsFlyer({
        hasToken: true,
        consentChecked: true,
        needsConsent: true,
      })
    ).toBe(false);
  });

  it('starts only for signed-in users with accepted consent', () => {
    expect(
      shouldStartAppsFlyer({
        hasToken: false,
        consentChecked: true,
        needsConsent: false,
      })
    ).toBe(false);
    expect(
      shouldStartAppsFlyer({
        hasToken: true,
        consentChecked: true,
        needsConsent: false,
      })
    ).toBe(true);
  });
});
