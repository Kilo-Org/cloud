import { describe, expect, it } from 'vitest';

import {
  formatAppleCreditAmount,
  getAppleCreditProductButtonText,
  shouldShowAppleCreditPurchaseEntry,
} from './apple-credit-purchase-utils';

describe('Apple credit purchase sheet helpers', () => {
  it('hides the buy entry point for organization balances', () => {
    expect(
      shouldShowAppleCreditPurchaseEntry({
        platform: 'ios',
        selectedOrgId: 'org-1',
      })
    ).toBe(false);
  });

  it('hides the buy entry point outside iOS', () => {
    expect(
      shouldShowAppleCreditPurchaseEntry({
        platform: 'android',
        selectedOrgId: undefined,
      })
    ).toBe(false);
  });

  it('shows the credited amount and localized Apple price', () => {
    expect(
      getAppleCreditProductButtonText({
        id: 'com.kilocode.kiloapp.credits.small.999',
        tier: 'small',
        creditedCents: 699,
        creditedMicrodollars: 6_990_000,
        title: 'Small Credit Pack',
        localizedPrice: '$9.99',
      })
    ).toBe('$6.99 credits - Pay $9.99');
  });

  it('formats credited amounts for retryable purchase rows', () => {
    expect(formatAppleCreditAmount(3499)).toBe('$34.99 credits');
  });
});
