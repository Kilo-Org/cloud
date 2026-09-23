import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as GooglePlaySdk from './google-play-sdk';

const mockGoogleAuth = jest.fn().mockImplementation((...args: unknown[]) => ({
  args,
  type: 'google-auth',
}));

const mockSubscriptionsV2Get = jest.fn().mockImplementation(() => ({
  data: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' },
}));

const mockAcknowledge = jest.fn<(request: unknown) => Promise<void>>().mockResolvedValue(undefined);

const mockSubscriptionsV2Revoke = jest
  .fn<(request: unknown) => Promise<void>>()
  .mockResolvedValue(undefined);

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
    subscriptions: { acknowledge: mockAcknowledge },
    subscriptionsv2: {
      get: mockSubscriptionsV2Get,
      revoke: mockSubscriptionsV2Revoke,
    },
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

  it('calls subscriptionsv2.get with the package name and token', async () => {
    const { getGooglePlaySubscriptionPurchase } = loadGooglePlaySdk();

    const data = await getGooglePlaySubscriptionPurchase('purchase-token');

    expect(mockSubscriptionsV2Get).toHaveBeenCalledWith({
      packageName: 'com.kilocode.kiloapp',
      token: 'purchase-token',
    });
    expect(data).toEqual({ subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' });
  });

  it('reads only subscription order fields and propagates provider errors', async () => {
    const { getGooglePlaySubscriptionOrder } = loadGooglePlaySdk();
    await expect(getGooglePlaySubscriptionOrder('paid-order')).resolves.toEqual({
      orderId: 'paid-order',
    });
    expect(mockOrdersGet).toHaveBeenCalledWith({
      packageName: 'com.kilocode.kiloapp',
      orderId: 'paid-order',
      fields:
        'orderId,purchaseToken,state,total,tax,lineItems(productId,total,tax,subscriptionDetails(servicePeriodStartTime,servicePeriodEndTime))',
    });
    mockOrdersGet.mockImplementationOnce(() => {
      throw new Error('provider unavailable');
    });
    await expect(getGooglePlaySubscriptionOrder('paid-order')).rejects.toThrow(
      'provider unavailable'
    );
  });

  it('acknowledges a verified subscription and tolerates a concurrent acknowledgement', async () => {
    const { acknowledgeGooglePlaySubscriptionPurchase } = loadGooglePlaySdk();
    await acknowledgeGooglePlaySubscriptionPurchase('kilopass_tier19', 'test-token');
    expect(mockAcknowledge).toHaveBeenCalledWith({
      packageName: 'com.kilocode.kiloapp',
      subscriptionId: 'kilopass_tier19',
      token: 'test-token',
      requestBody: {},
    });
    await acknowledgeGooglePlaySubscriptionPurchase('kilopass_tier19', 'test-token', 'account-id');
    expect(mockAcknowledge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestBody: { externalAccountIds: { obfuscatedAccountId: 'account-id' } },
      })
    );
    mockAcknowledge.mockRejectedValueOnce(new Error('response lost'));
    mockSubscriptionsV2Get.mockReturnValueOnce({
      data: { acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' },
    });
    await expect(
      acknowledgeGooglePlaySubscriptionPurchase('kilopass_tier19', 'test-token')
    ).resolves.toBeUndefined();
    mockAcknowledge.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(
      acknowledgeGooglePlaySubscriptionPurchase('kilopass_tier19', 'test-token')
    ).rejects.toThrow('provider unavailable');
  });

  it('revokes with a full refund and tolerates an already revoked subscription', async () => {
    const { revokeGooglePlaySubscriptionPurchase } = loadGooglePlaySdk();

    await revokeGooglePlaySubscriptionPurchase('test-token');
    expect(mockSubscriptionsV2Revoke).toHaveBeenCalledWith({
      packageName: 'com.kilocode.kiloapp',
      token: 'test-token',
      requestBody: { revocationContext: { fullRefund: {} } },
    });

    // A retried notification finds the subscription revoked and Play rejects the
    // repeat call; a subscription that no longer renews means success.
    mockSubscriptionsV2Revoke.mockRejectedValueOnce(new Error('already revoked'));
    mockSubscriptionsV2Get.mockReturnValueOnce({
      data: { subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' },
    });
    await expect(revokeGooglePlaySubscriptionPurchase('test-token')).resolves.toBeUndefined();
  });

  it('propagates a failed revoke unless the subscription is expired', async () => {
    const { revokeGooglePlaySubscriptionPurchase } = loadGooglePlaySdk();

    mockSubscriptionsV2Revoke.mockRejectedValueOnce(new Error('provider unavailable'));
    mockSubscriptionsV2Get.mockReturnValueOnce({
      data: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' },
    });
    await expect(revokeGooglePlaySubscriptionPurchase('test-token')).rejects.toThrow(
      'provider unavailable'
    );

    // CANCELED is still entitled and still charged, so a failed revoke must not
    // be mistaken for a reversal.
    mockSubscriptionsV2Revoke.mockRejectedValueOnce(new Error('provider unavailable'));
    mockSubscriptionsV2Get.mockReturnValueOnce({
      data: { subscriptionState: 'SUBSCRIPTION_STATE_CANCELED' },
    });
    await expect(revokeGooglePlaySubscriptionPurchase('test-token')).rejects.toThrow(
      'provider unavailable'
    );
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

  it('asserts the service account without building a client', () => {
    const { assertGooglePlayServiceAccountConfigured } = loadGooglePlaySdk();

    expect(() => assertGooglePlayServiceAccountConfigured()).not.toThrow();
    expect(mockAndroidPublisher).not.toHaveBeenCalled();

    delete process.env.GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON;
    expect(() => assertGooglePlayServiceAccountConfigured()).toThrow(
      'GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON is not set'
    );

    process.env.GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON = 'not-json';
    expect(() => assertGooglePlayServiceAccountConfigured()).toThrow(
      'GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON is invalid'
    );
  });
});
