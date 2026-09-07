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

const mockOrdersGet = jest.fn().mockImplementation(() => ({ data: { orderId: 'paid-order' } }));

const mockAndroidPublisher = jest.fn().mockImplementation((...args: unknown[]) => ({
  args,
  orders: { get: mockOrdersGet },
  purchases: {
    subscriptions: { acknowledge: mockAcknowledge },
    subscriptionsv2: {
      get: mockSubscriptionsV2Get,
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
        'orderId,purchaseToken,state,lineItems(productId,subscriptionDetails(servicePeriodStartTime,servicePeriodEndTime))',
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
    expect(mockAcknowledge).toHaveBeenLastCalledWith(expect.objectContaining({ requestBody: { externalAccountIds: { obfuscatedAccountId: 'account-id' } } }));
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
});
