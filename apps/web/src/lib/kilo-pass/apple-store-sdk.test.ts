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

  it('rejects an unsupported APPLE_IAP_ENVIRONMENT before building the verifier', () => {
    process.env.APPLE_IAP_ENVIRONMENT = 'production';
    const { createAppleStoreSignedDataVerifier } = loadAppleStoreSdk();

    expect(() => createAppleStoreSignedDataVerifier()).toThrow(
      'APPLE_IAP_ENVIRONMENT must be one of Production, Sandbox'
    );
    expect(mockSignedDataVerifier).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '-5', '1.5', '0x10'])(
    'rejects APPLE_APP_APPLE_ID %s before building the verifier',
    value => {
      process.env.APPLE_APP_APPLE_ID = value;
      const { createAppleStoreSignedDataVerifier } = loadAppleStoreSdk();

      expect(() => createAppleStoreSignedDataVerifier()).toThrow(
        'APPLE_APP_APPLE_ID must be a positive integer'
      );
      expect(mockSignedDataVerifier).not.toHaveBeenCalled();
    }
  );

  it('passes no App ID when APPLE_APP_APPLE_ID is empty', () => {
    process.env.APPLE_APP_APPLE_ID = '';
    const { createAppleStoreSignedDataVerifier } = loadAppleStoreSdk();

    createAppleStoreSignedDataVerifier();

    expect(mockSignedDataVerifier).toHaveBeenCalledWith(
      expect.any(Array),
      true,
      'Sandbox',
      'com.kilocode.kiloapp',
      undefined
    );
  });

  it('accepts a production environment with its numeric App ID', () => {
    process.env.APPLE_IAP_ENVIRONMENT = 'Production';
    const { createAppleStoreSignedDataVerifier } = loadAppleStoreSdk();

    createAppleStoreSignedDataVerifier();

    expect(mockSignedDataVerifier).toHaveBeenCalledWith(
      expect.any(Array),
      true,
      'Production',
      'com.kilocode.kiloapp',
      1234567890
    );
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

  it('reports which payload fields failed validation', async () => {
    mockVerifyAndDecodeTransaction.mockResolvedValueOnce({ productId: 'credits.usd10.v1' });
    const promise = loadAppleStoreSdk().decodeAppleStoreTransactionJws('invalid');
    await expect(promise).rejects.toThrow(/^Apple transaction payload failed validation: /);
    await expect(promise).rejects.toThrow(/validation: .*transactionId: /);
  });

  it('names a malformed field without echoing its value', async () => {
    mockVerifyAndDecodeTransaction.mockResolvedValueOnce({
      transactionId: 'credit-tx',
      originalTransactionId: 'credit-original',
      bundleId: 'com.kilocode.kiloapp',
      productId: 'credits.usd10.v1',
      purchaseDate: 1_777_626_000_000,
      appAccountToken: 'not-a-uuid',
    });
    const error = await loadAppleStoreSdk()
      .decodeAppleStoreTransactionJws('invalid')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/appAccountToken: /);
    expect((error as Error).message).not.toContain('not-a-uuid');
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
