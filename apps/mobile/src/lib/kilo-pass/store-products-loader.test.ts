import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAuthoredProductsErrorMessage,
  KiloPassProductsError,
  loadAppStoreKiloPassProducts,
  NO_MATCHING_KILO_PASS_PRODUCTS_KEY,
  NO_MATCHING_KILO_PASS_PRODUCTS_PLAY_KEY,
} from './store-products-loader';
import { KiloPassProductQueryError } from './product-query-failure';
import { type BackendStoreKiloPassProduct, type StoreKiloPassProduct } from './store-products';
import { i18n } from '@/i18n';
import {
  setTelemetrySink,
  TELEMETRY_DESCRIPTION_KEY,
  type TelemetryEvent,
} from '@/lib/telemetry/error-sink';

const storeQueryError = Object.assign(new Error('Failed to query products'), {
  code: 'query-product',
});

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

describe('loadAppStoreKiloPassProducts', () => {
  it('returns joined products only after backend and App Store products resolve', async () => {
    const fetchStoreProducts = vi.fn().mockResolvedValue([
      {
        id: 'kilopass.tier19.monthly.v1',
        displayPrice: '$24.99',
        title: 'Kilo Pass 19',
        description: 'Kilo Pass',
      },
    ]);

    const products = await loadAppStoreKiloPassProducts({
      storefront: 'app_store',
      fetchStoreProducts,
      loadBackendProducts: vi.fn().mockResolvedValue({
        appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
        products: backendProducts,
      }),
    });

    expect(fetchStoreProducts).toHaveBeenCalledWith([
      'kilopass.tier19.monthly.v1',
      'kilopass.tier49.monthly.v1',
    ]);
    expect(products).toEqual([
      expect.objectContaining({
        appleProductId: 'kilopass.tier19.monthly.v1',
        appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
        displayPrice: '$24.99',
      }),
    ]);
  });

  it('throws the empty App Store message after the store fetch returns no matching products', async () => {
    await expect(
      loadAppStoreKiloPassProducts({
        storefront: 'app_store',
        fetchStoreProducts: vi.fn().mockResolvedValue([]),
        loadBackendProducts: vi.fn().mockResolvedValue({
          appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
          products: backendProducts,
        }),
      })
    ).rejects.toThrow(i18n.t(NO_MATCHING_KILO_PASS_PRODUCTS_KEY));
  });

  it('throws the empty Google Play message after the store fetch returns no matching products', async () => {
    await expect(
      loadAppStoreKiloPassProducts({
        storefront: 'play',
        fetchStoreProducts: vi.fn().mockResolvedValue([]),
        loadBackendProducts: vi.fn().mockResolvedValue({
          appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
          products: backendProducts,
        }),
      })
    ).rejects.toThrow(i18n.t(NO_MATCHING_KILO_PASS_PRODUCTS_PLAY_KEY));
  });

  it('fetches Google product ids for the Play storefront', async () => {
    const fetchStoreProducts = vi.fn().mockResolvedValue([
      {
        id: 'kilopass_tier19',
        displayPrice: '$24.99',
        title: 'Kilo Pass 19',
        description: 'Kilo Pass',
      },
    ]);

    await loadAppStoreKiloPassProducts({
      storefront: 'play',
      fetchStoreProducts,
      loadBackendProducts: vi.fn().mockResolvedValue({
        appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
        products: backendProducts,
      }),
    });

    expect(fetchStoreProducts).toHaveBeenCalledWith(['kilopass_tier19', 'kilopass_tier49']);
  });
});

describe('getAuthoredProductsErrorMessage', () => {
  it('keeps a message this app wrote', () => {
    expect(
      getAuthoredProductsErrorMessage(new KiloPassProductsError('No matching products.'))
    ).toBe('No matching products.');
  });

  it('drops a store SDK message so the screen uses its own localized copy', () => {
    expect(getAuthoredProductsErrorMessage(new Error('Failed to query product'))).toBeNull();
  });

  it('drops a non-error rejection', () => {
    expect(getAuthoredProductsErrorMessage('Failed to query product')).toBeNull();
    expect(getAuthoredProductsErrorMessage(null)).toBeNull();
  });
});

const playTier19StoreProduct: StoreKiloPassProduct = {
  id: 'kilopass_tier19',
  displayPrice: '$24.99',
  title: 'Kilo Pass 19',
  description: 'Kilo Pass',
};

const playTier49StoreProduct: StoreKiloPassProduct = {
  id: 'kilopass_tier49',
  displayPrice: '$63.99',
  title: 'Kilo Pass 49',
  description: 'Kilo Pass',
};

function backendResponse() {
  return {
    appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
    products: backendProducts,
  };
}

async function loadFailure(
  params: Parameters<typeof loadAppStoreKiloPassProducts>[0]
): Promise<KiloPassProductQueryError> {
  try {
    await loadAppStoreKiloPassProducts(params);
  } catch (error) {
    if (error instanceof KiloPassProductQueryError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the loader to reject');
}

describe('loadAppStoreKiloPassProducts with a rejecting store', () => {
  it('reports the failure as a typed outcome with a stable fingerprint', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchStoreProducts = vi.fn().mockRejectedValue(storeQueryError);

    const failure = await loadFailure({
      storefront: 'play',
      fetchStoreProducts,
      loadBackendProducts: vi.fn().mockResolvedValue(backendResponse()),
    });

    expect(failure.platform).toBe('android');
    expect(failure.storefront).toBe('play');
    expect(failure.storeCode).toBe('query-product');
    expect(failure.productIds).toEqual(['kilopass_tier19', 'kilopass_tier49']);
    expect(failure[TELEMETRY_DESCRIPTION_KEY].fingerprint).toEqual([
      'kilo-pass-product-query',
      'store-unavailable',
      'android',
      'play',
      'query-product',
    ]);
    // The screen must render its own localized copy, never the store SDK's.
    expect(getAuthoredProductsErrorMessage(failure)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[kilo-pass] store product query store-unavailable platform=android storefront=play code=query-product productIds=[kilopass_tier19, kilopass_tier49]'
    );
  });

  it('keeps the tiers that resolve and reports the identifiers the store rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The combined request, then the per-identifier probes in product order.
    const fetchStoreProducts = vi
      .fn()
      .mockRejectedValueOnce(storeQueryError)
      .mockResolvedValueOnce([playTier19StoreProduct])
      .mockRejectedValueOnce(storeQueryError);

    const products = await loadAppStoreKiloPassProducts({
      storefront: 'play',
      fetchStoreProducts,
      loadBackendProducts: vi.fn().mockResolvedValue(backendResponse()),
    });

    expect(products.map(product => product.googleProductId)).toEqual(['kilopass_tier19']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'warning',
      error: storeQueryError,
      tags: {
        'error.subsystem': 'kilo-pass',
        'kilo_pass.failure_kind': 'unresolved-identifiers',
        'kilo_pass.store_code': 'query-product',
      },
      contexts: { kiloPassProductQuery: { productIds: ['kilopass_tier49'] } },
      fingerprint: [
        'kilo-pass-product-query',
        'unresolved-identifiers',
        'android',
        'play',
        'query-product',
      ],
    });
    expect(warn).toHaveBeenCalledWith(
      '[kilo-pass] store product query unresolved-identifiers platform=android storefront=play code=query-product productIds=[kilopass_tier49]'
    );
  });

  it('reports an identifier the store silently omits', async () => {
    const fetchStoreProducts = vi
      .fn()
      .mockRejectedValueOnce(storeQueryError)
      .mockResolvedValueOnce([playTier19StoreProduct])
      .mockResolvedValueOnce([]);

    const products = await loadAppStoreKiloPassProducts({
      storefront: 'play',
      fetchStoreProducts,
      loadBackendProducts: vi.fn().mockResolvedValue(backendResponse()),
    });

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
  });

  it('uses the per-identifier answers when every identifier resolves alone', async () => {
    const fetchStoreProducts = vi
      .fn()
      .mockRejectedValueOnce(storeQueryError)
      .mockResolvedValueOnce([playTier19StoreProduct])
      .mockResolvedValueOnce([playTier49StoreProduct]);

    const products = await loadAppStoreKiloPassProducts({
      storefront: 'play',
      fetchStoreProducts,
      loadBackendProducts: vi.fn().mockResolvedValue(backendResponse()),
    });

    expect(products.map(product => product.googleProductId)).toEqual([
      'kilopass_tier19',
      'kilopass_tier49',
    ]);
    expect(events).toEqual([]);
  });
});
