import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BackendStoreKiloPassProduct, type StoreKiloPassProduct } from './store-products';
import { loadAppStoreKiloPassProducts } from './store-products-loader';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';

// A store that answers a combined request successfully can still omit an
// identifier it cannot resolve: iOS drops an unknown product instead of
// rejecting. These tests pin that the omission is probed and reported exactly
// like a rejection, and that a tier which resolves on its own probe is kept.

const backendProducts: BackendStoreKiloPassProduct[] = [
  {
    tier: 'tier_19',
    cadence: 'monthly',
    appleProductId: 'kilopass.tier19.monthly.v1',
    googleProductId: 'kilopass_tier19',
    googleBasePlanId: 'monthly-v1',
    webMonthlyPriceUsd: 19,
    suggestedStoreMonthlyPriceUsd: 24.7,
  },
  {
    tier: 'tier_49',
    cadence: 'monthly',
    appleProductId: 'kilopass.tier49.monthly.v1',
    googleProductId: 'kilopass_tier49',
    googleBasePlanId: 'monthly-v1',
    webMonthlyPriceUsd: 49,
    suggestedStoreMonthlyPriceUsd: 63.7,
  },
];

function playStoreProduct(id: string, displayPrice: string): StoreKiloPassProduct {
  return { id, displayPrice, title: `Kilo Pass ${id}`, description: 'Kilo Pass' };
}

let events: TelemetryEvent[] = [];

beforeEach(() => {
  events = [];
  setTelemetrySink(event => {
    events.push(event);
  });
});

afterEach(() => {
  setTelemetrySink(null);
  vi.restoreAllMocks();
});

/** The store answers each call with the next list, in order. */
async function loadFromStoreAnswers(answers: readonly (readonly StoreKiloPassProduct[])[]) {
  const fetchStoreProducts = vi.fn();
  for (const answer of answers) {
    fetchStoreProducts.mockResolvedValueOnce(answer);
  }

  const products = await loadAppStoreKiloPassProducts({
    storefront: 'play',
    fetchStoreProducts,
    loadBackendProducts: vi.fn().mockResolvedValue({
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      products: backendProducts,
    }),
  });

  return { fetchStoreProducts, products };
}

describe('loadAppStoreKiloPassProducts with a store that omits an identifier', () => {
  it('probes and reports an identifier missing from a successful combined answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fetchStoreProducts, products } = await loadFromStoreAnswers([
      [playStoreProduct('kilopass_tier19', '$24.99')],
      [],
    ]);

    expect(fetchStoreProducts).toHaveBeenNthCalledWith(2, ['kilopass_tier49']);
    expect(products.map(product => product.googleProductId)).toEqual(['kilopass_tier19']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'warning',
      contexts: { kiloPassProductQuery: { productIds: ['kilopass_tier49'], code: null } },
      fingerprint: [
        'kilo-pass-product-query',
        'unresolved-identifiers',
        'android',
        'play',
        'unknown',
      ],
    });
    expect(warn).toHaveBeenCalledWith(
      '[kilo-pass] store product query unresolved-identifiers platform=android storefront=play code=unknown productIds=[kilopass_tier49]'
    );
  });

  it('keeps an identifier that resolves on its own probe instead of dropping the tier', async () => {
    const { products } = await loadFromStoreAnswers([
      [playStoreProduct('kilopass_tier19', '$24.99')],
      [playStoreProduct('kilopass_tier49', '$63.99')],
    ]);

    expect(products.map(product => product.googleProductId)).toEqual([
      'kilopass_tier19',
      'kilopass_tier49',
    ]);
    expect(events).toEqual([]);
  });
});
