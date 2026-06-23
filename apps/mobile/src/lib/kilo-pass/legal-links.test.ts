import { describe, expect, it } from 'vitest';

import { getKiloPassLegalLinks, KILO_PASS_LEGAL_DISCLOSURE } from './legal-links';

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
    expect(KILO_PASS_LEGAL_DISCLOSURE).toBe(
      'Kilo Pass is an auto-renewable monthly subscription. Payment is charged to your Apple ID at confirmation of purchase. Subscriptions renew automatically each month at the price shown unless canceled at least 24 hours before the end of the current period. Manage or cancel anytime in your App Store account settings.'
    );
  });

  it('composes the full footer disclosure with legal link labels', () => {
    const [privacyPolicyLink, termsOfUseLink] = getKiloPassLegalLinks('https://app.example.com');

    expect(
      `${KILO_PASS_LEGAL_DISCLOSURE} By subscribing, you agree to the ${termsOfUseLink.label} and acknowledge the ${privacyPolicyLink.label}.`
    ).toBe(
      'Kilo Pass is an auto-renewable monthly subscription. Payment is charged to your Apple ID at confirmation of purchase. Subscriptions renew automatically each month at the price shown unless canceled at least 24 hours before the end of the current period. Manage or cancel anytime in your App Store account settings. By subscribing, you agree to the Terms of Use (EULA) and acknowledge the Privacy Policy.'
    );
  });
});
