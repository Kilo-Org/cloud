export type AppleCreditProductTier = 'small' | 'medium' | 'large';

export type AppleCreditProduct = {
  id: string;
  tier: AppleCreditProductTier;
  grossPriceCents: number;
  creditedCents: number;
  creditedMicrodollars: number;
  enabled: boolean;
};

export const APPLE_IAP_CREDIT_PRODUCTS = [
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
] as const satisfies readonly AppleCreditProduct[];

export function getAppleCreditProduct(productId: string): AppleCreditProduct | null {
  return APPLE_IAP_CREDIT_PRODUCTS.find(product => product.id === productId) ?? null;
}

export function getEnabledAppleCreditProducts() {
  return APPLE_IAP_CREDIT_PRODUCTS.filter(product => product.enabled).map(product => ({
    id: product.id,
    tier: product.tier,
    creditedCents: product.creditedCents,
    creditedMicrodollars: product.creditedMicrodollars,
  }));
}
