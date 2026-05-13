import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as AppleStoreSdk from './apple-store-sdk';

const mockAppStoreServerAPIClient = jest.fn().mockImplementation((...args: unknown[]) => ({
  args,
  type: 'api-client',
}));
const mockSignedDataVerifier = jest.fn().mockImplementation((...args: unknown[]) => ({
  args,
  type: 'signed-data-verifier',
}));

jest.mock('@apple/app-store-server-library', () => ({
  AppStoreServerAPIClient: mockAppStoreServerAPIClient,
  Environment: {
    PRODUCTION: 'Production',
    SANDBOX: 'Sandbox',
  },
  SignedDataVerifier: mockSignedDataVerifier,
}));

function loadAppleStoreSdk(): typeof AppleStoreSdk {
  return jest.requireActual<typeof AppleStoreSdk>('./apple-store-sdk');
}

describe('apple-store-sdk', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.APPLE_IAP_ENVIRONMENT = 'Sandbox';
    process.env.APPLE_APP_APPLE_ID = '1234567890';
    process.env.APPLE_ROOT_CERTIFICATES_PEM =
      '-----BEGIN CERTIFICATE-----\nroot-a\n-----END CERTIFICATE-----';
    process.env.APPLE_IAP_PRIVATE_KEY =
      '-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----';
    process.env.APPLE_IAP_KEY_ID = 'key-id';
    process.env.APPLE_IAP_ISSUER_ID = 'issuer-id';
    jest.clearAllMocks();
  });

  it('reuses signed data verifier setup for unchanged Apple config', () => {
    const { createAppleStoreSignedDataVerifier } = loadAppleStoreSdk();

    const first = createAppleStoreSignedDataVerifier();
    const second = createAppleStoreSignedDataVerifier();

    expect(second).toBe(first);
    expect(mockSignedDataVerifier).toHaveBeenCalledTimes(1);
  });

  it('reuses server API client setup for unchanged Apple config', () => {
    const { createAppleStoreServerApiClient } = loadAppleStoreSdk();

    const first = createAppleStoreServerApiClient();
    const second = createAppleStoreServerApiClient();

    expect(second).toBe(first);
    expect(mockAppStoreServerAPIClient).toHaveBeenCalledTimes(1);
  });
});
