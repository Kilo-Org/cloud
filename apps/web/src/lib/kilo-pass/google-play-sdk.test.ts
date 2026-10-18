import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as GooglePlaySdk from './google-play-sdk';

const mockGoogleAuth = jest.fn().mockImplementation((...args: unknown[]) => ({
  args,
  type: 'google-auth',
}));

const mockOrdersGet = jest.fn().mockImplementation(() => ({ data: { orderId: 'paid-order' } }));

const mockProductsGet = jest
  .fn()
  .mockImplementation(() => ({ data: { productId: 'credits_usd10', purchaseState: 0 } }));

const mockProductsConsume = jest
  .fn<(request: unknown) => Promise<void>>()
  .mockResolvedValue(undefined);

const mockAndroidPublisher = jest.fn().mockImplementation((...args: unknown[]) => ({
  args,
  orders: { get: mockOrdersGet },
  purchases: {
    products: { get: mockProductsGet, consume: mockProductsConsume },
  },
}));

jest.mock('google-auth-library', () => ({
  GoogleAuth: mockGoogleAuth,
}));

jest.mock('@googleapis/androidpublisher', () => ({
  androidpublisher: mockAndroidPublisher,
}));

function loadGooglePlaySdk(): typeof GooglePlaySdk {
  return jest.requireActual<typeof GooglePlaySdk>('./google-play-sdk');
}

describe('google-play-sdk', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON = JSON.stringify({
      client_email: 'publisher@example.com',
      private_key: 'private-key',
    });
    jest.clearAllMocks();
  });

  it('reuses the Android Publisher client for unchanged JSON', () => {
    const { createGooglePlayAndroidPublisherClient } = loadGooglePlaySdk();

    const first = createGooglePlayAndroidPublisherClient();
    const second = createGooglePlayAndroidPublisherClient();

    expect(second).toBe(first);
    expect(mockAndroidPublisher).toHaveBeenCalledTimes(1);
  });

  it('constructs GoogleAuth with the androidpublisher scope', () => {
    const { createGooglePlayAndroidPublisherClient } = loadGooglePlaySdk();

    createGooglePlayAndroidPublisherClient();

    expect(mockGoogleAuth).toHaveBeenCalledWith({
      credentials: expect.objectContaining({
        client_email: 'publisher@example.com',
        private_key: 'private-key',
      }),
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
  });

  it('reads order fields for credit-pack refunds and propagates provider errors', async () => {
    const { getGooglePlayOrder } = loadGooglePlaySdk();
    await expect(getGooglePlayOrder('paid-order')).resolves.toEqual({
      orderId: 'paid-order',
    });
    expect(mockOrdersGet).toHaveBeenCalledWith({
      packageName: 'com.kilocode.kiloapp',
      orderId: 'paid-order',
      fields:
        'orderId,purchaseToken,state,total,tax,lineItems(productId,total,tax,subscriptionDetails(servicePeriodStartTime,servicePeriodEndTime),oneTimePurchaseDetails(quantity))',
    });
    mockOrdersGet.mockImplementationOnce(() => {
      throw new Error('provider unavailable');
    });
    await expect(getGooglePlayOrder('paid-order')).rejects.toThrow('provider unavailable');
  });

  it('calls purchases.products.get with the package name, product id and token', async () => {
    const { getGooglePlayProductPurchase } = loadGooglePlaySdk();

    const data = await getGooglePlayProductPurchase('credits_usd10', 'purchase-token');

    expect(mockProductsGet).toHaveBeenCalledWith({
      packageName: 'com.kilocode.kiloapp',
      productId: 'credits_usd10',
      token: 'purchase-token',
    });
    expect(data).toEqual({ productId: 'credits_usd10', purchaseState: 0 });
  });

  it('consumes a one-time product and tolerates an already-consumed purchase', async () => {
    const { consumeGooglePlayProductPurchase } = loadGooglePlaySdk();

    await consumeGooglePlayProductPurchase('credits_usd10', 'purchase-token');
    expect(mockProductsConsume).toHaveBeenCalledWith({
      packageName: 'com.kilocode.kiloapp',
      productId: 'credits_usd10',
      token: 'purchase-token',
    });

    // The app can consume concurrently, or the response can be lost.
    mockProductsConsume.mockRejectedValueOnce(new Error('already consumed'));
    mockProductsGet.mockReturnValueOnce({ data: { consumptionState: 1 } });
    await expect(
      consumeGooglePlayProductPurchase('credits_usd10', 'purchase-token')
    ).resolves.toBeUndefined();
  });

  it('propagates a consume failure unless the purchase is consumed', async () => {
    const { consumeGooglePlayProductPurchase } = loadGooglePlaySdk();

    mockProductsConsume.mockRejectedValueOnce(new Error('provider unavailable'));
    mockProductsGet.mockReturnValueOnce({ data: { consumptionState: 0 } });
    await expect(
      consumeGooglePlayProductPurchase('credits_usd10', 'purchase-token')
    ).rejects.toThrow('provider unavailable');
  });

  it('throws when the service account JSON is not set', () => {
    delete process.env.GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON;

    const { createGooglePlayAndroidPublisherClient } = loadGooglePlaySdk();

    expect(() => createGooglePlayAndroidPublisherClient()).toThrow(
      'GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON is not set'
    );
  });

  it('throws when the service account JSON is invalid', () => {
    process.env.GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON = JSON.stringify({
      client_email: 'publisher@example.com',
    });

    const { createGooglePlayAndroidPublisherClient } = loadGooglePlaySdk();

    expect(() => createGooglePlayAndroidPublisherClient()).toThrow(
      'GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON is invalid'
    );
  });

  it('throws when the service account value is not JSON', () => {
    process.env.GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON = 'not-json';

    const { createGooglePlayAndroidPublisherClient } = loadGooglePlaySdk();

    expect(() => createGooglePlayAndroidPublisherClient()).toThrow(
      'GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON is invalid'
    );
  });
});
