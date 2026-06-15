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

  it('uses platform-neutral subscription disclosure copy', () => {
    expect(KILO_PASS_LEGAL_DISCLOSURE).toBe(
      'Subscriptions renew monthly until canceled. Manage or cancel anytime through your app store account settings.'
    );
  });
});
