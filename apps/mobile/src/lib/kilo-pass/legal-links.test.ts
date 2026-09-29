import { describe, expect, it } from 'vitest';

import { getKiloPassLegalLinks, kiloPassLegalDisclosure } from './legal-links';

describe('Kilo Pass legal disclosure links', () => {
  it('includes functional privacy policy and Terms of Use links for the purchase flow', () => {
    expect(getKiloPassLegalLinks('https://app.example.com')).toEqual([
      {
        label: 'Privacy Policy',
        url: 'https://app.example.com/privacy-app',
      },
      {
        label: 'Terms of Use (EULA)',
        url: 'https://app.example.com/terms-app',
      },
    ]);
  });

  it('uses App Store auto-renewable monthly subscription disclosure copy', () => {
    expect(kiloPassLegalDisclosure('ios')).toBe(
      'Kilo Pass is an auto-renewable monthly subscription. Payment is charged to your Apple ID at confirmation of purchase. Subscriptions renew automatically each month at the price shown unless canceled at least 24 hours before the end of the current period. Manage or cancel anytime in your App Store account settings.'
    );
  });

  it('uses Google Play auto-renewable monthly subscription disclosure copy on Android', () => {
    expect(kiloPassLegalDisclosure('android')).toBe(
      'Kilo Pass is an auto-renewable monthly subscription. Payment is charged to your Google Play account at confirmation of purchase. Subscriptions renew automatically each month at the price shown unless canceled at least 24 hours before the end of the current period. Manage or cancel anytime in your Google Play account settings.'
    );
  });
});
