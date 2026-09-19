import { afterEach, describe, expect, jest, test } from '@jest/globals';

// A valid 32-byte AES key that is not the one the promo codes in source were
// encrypted with — the state a development worktree gets when its generated or
// pulled key does not match the committed ciphertexts.
const MISMATCHED_KEY = Buffer.alloc(32, 7).toString('base64');
const UNREADABLE_CIPHERTEXT = 'aXY=:dGFn:Y2lwaGVy';

type PromoEncryptionModule = { decryptPromoCode: (encrypted: string) => string };

function loadModule(nodeEnv: 'development' | 'production' | 'test'): PromoEncryptionModule {
  jest.resetModules();
  jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: nodeEnv });
  jest.doMock('@/lib/config.server', () => ({
    CREDIT_CATEGORIES_ENCRYPTION_KEY_V2: '',
    CREDIT_CATEGORIES_ENCRYPTION_KEY: MISMATCHED_KEY,
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  return require('./promoCreditEncryption') as PromoEncryptionModule;
}

describe('decryptPromoCode', () => {
  afterEach(() => {
    jest.dontMock('@/lib/config.server');
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('falls back to a placeholder when the configured key cannot decrypt the stored code', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { decryptPromoCode } = loadModule('development');

    expect(() => decryptPromoCode(UNREADABLE_CIPHERTEXT)).not.toThrow();
    expect(decryptPromoCode(UNREADABLE_CIPHERTEXT)).toMatch(/^TEST-PROMO-/);
    expect(warn).toHaveBeenCalled();
  });

  test('still fails loudly on a key mismatch in production', () => {
    const { decryptPromoCode } = loadModule('production');

    expect(() => decryptPromoCode(UNREADABLE_CIPHERTEXT)).toThrow();
  });
});
