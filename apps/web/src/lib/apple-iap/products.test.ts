import { APPLE_IAP_CREDIT_PRODUCTS, getEnabledAppleCreditProducts } from './products';

describe('Apple IAP products', () => {
  it('defines the three v1 products with credited amounts', () => {
    expect(APPLE_IAP_CREDIT_PRODUCTS).toEqual([
      {
        id: 'com.kilocode.kiloapp.credits.small.999',
        tier: 'small',
        grossPriceCents: 999,
        creditedCents: 699,
        creditedMicrodollars: 6_990_000,
        enabled: true,
      },
      {
        id: 'com.kilocode.kiloapp.credits.medium.1999',
        tier: 'medium',
        grossPriceCents: 1999,
        creditedCents: 1399,
        creditedMicrodollars: 13_990_000,
        enabled: true,
      },
      {
        id: 'com.kilocode.kiloapp.credits.large.4999',
        tier: 'large',
        grossPriceCents: 4999,
        creditedCents: 3499,
        creditedMicrodollars: 34_990_000,
        enabled: true,
      },
    ]);
  });

  it('returns only enabled products for clients', () => {
    expect(getEnabledAppleCreditProducts()).toEqual(
      APPLE_IAP_CREDIT_PRODUCTS.map(product => ({
        id: product.id,
        tier: product.tier,
        creditedCents: product.creditedCents,
        creditedMicrodollars: product.creditedMicrodollars,
      }))
    );
  });
});
