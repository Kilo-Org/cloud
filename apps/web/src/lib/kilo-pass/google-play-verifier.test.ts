import { describe, expect, it, jest } from '@jest/globals';
import type { androidpublisher_v3 } from '@googleapis/androidpublisher';

import { KiloPassCadence, KiloPassPaymentProvider, KiloPassTier } from './enums';
import type * as GooglePlayVerifier from './google-play-verifier';

const mockGetGooglePlaySubscriptionPurchase = jest.fn();

jest.mock('./google-play-sdk', () => ({
  getGooglePlaySubscriptionPurchase: mockGetGooglePlaySubscriptionPurchase,
}));

function loadVerifier(): typeof GooglePlayVerifier {
  return jest.requireActual<typeof GooglePlayVerifier>('./google-play-verifier');
}

function decoded(
  overrides: Partial<GooglePlayVerifier.GooglePlayDecodedPurchase> = {}
): GooglePlayVerifier.GooglePlayDecodedPurchase {
  return {
    purchaseToken: 'play-token-1',
    productId: 'kilopass_tier19',
    latestOrderId: 'GPA.1234',
    startTimeMs: 1_777_626_000_000,
    expiryTimeMs: 4_102_444_800_000,
    obfuscatedExternalAccountId: '550e8400-e29b-41d4-a716-446655440000',
    environment: 'Sandbox',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    rawPayload: { purchaseToken: 'play-token-1' },
    ...overrides,
  };
}

function apiData(
  overrides: Partial<androidpublisher_v3.Schema$SubscriptionPurchaseV2> = {}
): androidpublisher_v3.Schema$SubscriptionPurchaseV2 {
  return {
    startTime: '2026-05-01T09:00:00.000Z',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    externalAccountIdentifiers: {
      obfuscatedExternalAccountId: '550e8400-e29b-41d4-a716-446655440000',
    },
    lineItems: [
      {
        productId: 'kilopass_tier19',
        expiryTime: '2100-01-01T00:00:00.000Z',
        latestSuccessfulOrderId: 'GPA.1234',
      },
    ],
    ...overrides,
  };
}

describe('mapGooglePlayKiloPassPurchase', () => {
  it('maps a valid Play subscription purchase to a validated Kilo Pass purchase', () => {
    const { mapGooglePlayKiloPassPurchase } = loadVerifier();

    expect(mapGooglePlayKiloPassPurchase(decoded())).toMatchObject({
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      productId: 'kilopass_tier19',
      providerTransactionId: 'GPA.1234',
      providerOriginalTransactionId: 'play-token-1',
      providerSubscriptionId: 'play-token-1',
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      purchaseToken: 'play-token-1',
      expiresAtIso: '2100-01-01T00:00:00.000Z',
      environment: 'Sandbox',
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
  });

  it('rejects an empty latest order id', () => {
    const { mapGooglePlayKiloPassPurchase } = loadVerifier();

    expect(() => mapGooglePlayKiloPassPurchase(decoded({ latestOrderId: '' }))).toThrow(
      'Google Play purchase payload missing required identifiers'
    );
  });

  it('rejects expired subscriptions', () => {
    const { mapGooglePlayKiloPassPurchase } = loadVerifier();

    expect(() =>
      mapGooglePlayKiloPassPurchase(decoded({ expiryTimeMs: Date.now() - 1_000 }))
    ).toThrow('Google Play subscription purchase has expired');
  });

  it('rejects unknown products', () => {
    const { mapGooglePlayKiloPassPurchase } = loadVerifier();

    expect(() => mapGooglePlayKiloPassPurchase(decoded({ productId: 'unknown' }))).toThrow(
      'Google Play Kilo Pass product is not enabled'
    );
  });
});

describe('decodeGooglePlaySubscriptionPurchase', () => {
  it('marks a test purchase as Sandbox', () => {
    const { decodeGooglePlaySubscriptionPurchase } = loadVerifier();

    const result = decodeGooglePlaySubscriptionPurchase(
      apiData({ testPurchase: {} }),
      'play-token-1'
    );

    expect(result.environment).toBe('Sandbox');
    expect(result.purchaseToken).toBe('play-token-1');
    expect(result.productId).toBe('kilopass_tier19');
    expect(result.latestOrderId).toBe('GPA.1234');
    expect(result.startTimeMs).toBe(1_777_626_000_000);
    expect(result.expiryTimeMs).toBe(4_102_444_800_000);
    expect(result.obfuscatedExternalAccountId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('marks a non-test purchase as Production', () => {
    const { decodeGooglePlaySubscriptionPurchase } = loadVerifier();

    const result = decodeGooglePlaySubscriptionPurchase(apiData(), 'play-token-1');

    expect(result.environment).toBe('Production');
  });

  it('throws when lineItems is empty', () => {
    const { decodeGooglePlaySubscriptionPurchase } = loadVerifier();

    expect(() =>
      decodeGooglePlaySubscriptionPurchase(apiData({ lineItems: [] }), 'play-token-1')
    ).toThrow('Google Play subscription purchase missing line items');
  });

  it('throws when lineItems is missing', () => {
    const { decodeGooglePlaySubscriptionPurchase } = loadVerifier();

    expect(() =>
      decodeGooglePlaySubscriptionPurchase(apiData({ lineItems: undefined }), 'play-token-1')
    ).toThrow('Google Play subscription purchase missing line items');
  });

  it('falls back to the top-level latest order id when the line item has none', () => {
    const { decodeGooglePlaySubscriptionPurchase } = loadVerifier();

    const data = {
      startTime: '2026-05-01T09:00:00.000Z',
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      lineItems: [
        {
          productId: 'kilopass_tier19',
          expiryTime: '2100-01-01T00:00:00.000Z',
        },
      ],
      latestOrderId: 'GPA.fallback',
    } as androidpublisher_v3.Schema$SubscriptionPurchaseV2;

    const result = decodeGooglePlaySubscriptionPurchase(data, 'play-token-1');

    expect(result.latestOrderId).toBe('GPA.fallback');
  });
});

describe('verifyGooglePlayKiloPassPurchase', () => {
  it('returns a validated purchase for the fixture payload', async () => {
    const { verifyGooglePlayKiloPassPurchase } = loadVerifier();

    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiData({ testPurchase: {} }));

    const result = await verifyGooglePlayKiloPassPurchase('play-token-1');

    expect(mockGetGooglePlaySubscriptionPurchase).toHaveBeenCalledWith('play-token-1');
    expect(result).toMatchObject({
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      productId: 'kilopass_tier19',
      providerTransactionId: 'GPA.1234',
      providerSubscriptionId: 'play-token-1',
      purchaseToken: 'play-token-1',
      environment: 'Sandbox',
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
    });
  });
});
