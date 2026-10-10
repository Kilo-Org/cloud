import { describe, expect, it } from 'vitest';

import { getStoreLegalLinks } from './legal-links';

describe('Store purchase legal links', () => {
  it('includes functional privacy policy and Terms of Use links for the purchase flow', () => {
    expect(getStoreLegalLinks('https://app.example.com')).toEqual([
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
});
