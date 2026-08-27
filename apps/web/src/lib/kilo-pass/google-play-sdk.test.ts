import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as GooglePlaySdk from './google-play-sdk';

const mockGoogleAuth = jest.fn().mockImplementation((...args: unknown[]) => ({
  args,
  type: 'google-auth',
}));

const mockSubscriptionsV2Get = jest.fn().mockImplementation((...args: unknown[]) => ({
  data: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' },
}));

const mockAndroidPublisher = jest.fn().mockImplementation((...args: unknown[]) => ({
  args,
  purchases: {
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
