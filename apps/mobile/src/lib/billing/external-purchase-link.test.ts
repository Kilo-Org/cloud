import { describe, expect, it } from 'vitest';

import { canLinkExternalPurchase } from '@/lib/billing/external-purchase-rule';

describe('canLinkExternalPurchase', () => {
  it('links only in the US App Store storefront on iOS', () => {
    expect(canLinkExternalPurchase('ios', 'USA')).toBe(true);
  });

  it('prints text for another App Store storefront', () => {
    expect(canLinkExternalPurchase('ios', 'DEU')).toBe(false);
    expect(canLinkExternalPurchase('ios', 'GBR')).toBe(false);
  });

  it('prints text when the storefront is unknown', () => {
    expect(canLinkExternalPurchase('ios', null)).toBe(false);
  });

  it('prints text on Android, which has no storefront that may link', () => {
    expect(canLinkExternalPurchase('android', 'USA')).toBe(false);
    expect(canLinkExternalPurchase('android', 'USA'.toLowerCase())).toBe(false);
  });
});
