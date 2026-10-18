import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as AppleStoreSdk from './apple-store-sdk';

const mockAppStoreServerAPIClient = jest.fn().mockImplementation((...args: unknown[]) => ({
  args,
  type: 'api-client',
}));
const mockVerifyAndDecodeTransaction = jest.fn<(jws: string) => Promise<Record<string, unknown>>>();
const mockSignedDataVerifier = jest.fn().mockImplementation((...args: unknown[]) => ({
  args,
  type: 'signed-data-verifier',
  verifyAndDecodeTransaction: mockVerifyAndDecodeTransaction,
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
  it('verifies and decodes a consumable transaction without subscription fields', async () => {
    const payload = {
      transactionId: 'credit-tx',
      originalTransactionId: 'credit-original',
      bundleId: 'com.kilocode.kiloapp',
      productId: 'credits.usd10.v1',
      purchaseDate: 1_777_626_000_000,
      environment: 'Production',
      quantity: 2,
      revocationType: 'REFUND_PRORATED',
      revocationPercentage: 30_000,
      revocationReason: 1,
      currency: 'USD',
      price: 10_000,
    };
    mockVerifyAndDecodeTransaction.mockResolvedValueOnce(payload);
    const { decodeAppleStoreTransactionJws } = loadAppleStoreSdk();
    await expect(decodeAppleStoreTransactionJws('signed-credit')).resolves.toMatchObject({
      transactionId: payload.transactionId,
      productId: payload.productId,
      environment: 'Production',
      revocationType: payload.revocationType,
      revocationPercentage: payload.revocationPercentage,
      revocationReason: payload.revocationReason,
      currency: payload.currency,
      price: payload.price,
      rawPayload: payload,
    });
    expect(mockVerifyAndDecodeTransaction).toHaveBeenCalledWith('signed-credit');
  });

  it('rejects transaction payloads missing required identifiers', async () => {
    mockVerifyAndDecodeTransaction.mockResolvedValueOnce({ productId: 'credits.usd10.v1' });
    await expect(loadAppleStoreSdk().decodeAppleStoreTransactionJws('invalid')).rejects.toThrow(
      'Apple transaction payload missing required identifiers'
    );
  });

  it('propagates signature verification failures', async () => {
    mockVerifyAndDecodeTransaction.mockRejectedValueOnce(new Error('invalid signature'));
    await expect(loadAppleStoreSdk().decodeAppleStoreTransactionJws('invalid')).rejects.toThrow(
      'invalid signature'
    );
  });

  it.each([
    ['Production', 'Production'],
    ['Sandbox', 'Sandbox'],
    [undefined, 'Sandbox'],
    ['unknown', 'Sandbox'],
  ])('normalizes environment %s to %s', (input, expected) => {
    expect(loadAppleStoreSdk().normalizeEnvironment(input)).toBe(expected);
  });
});
