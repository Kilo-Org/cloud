import { describe, expect, jest, test } from '@jest/globals';

/**
 * Decrypts every encrypted self-service entry except one chosen ciphertext,
 * which throws. Failing exactly one value is what lets the test distinguish
 * "skip only the undecryptable entry" from "drop every encrypted entry on the
 * first failure"; a mock that throws for every ciphertext leaves
 * `selfServicePromos` empty and cannot tell the two apart.
 */
const decryptCalls: string[] = [];
let failingCiphertext: string | undefined;

const mockDecryptPromoCode = jest.fn((encrypted: string): string => {
  decryptCalls.push(encrypted);
  failingCiphertext ??= encrypted;
  if (encrypted === failingCiphertext) {
    throw new Error('Unsupported state or unable to authenticate data');
  }
  return `decrypted:${encrypted}`;
});

jest.mock('@/lib/promoCreditEncryption', () => ({
  decryptPromoCode: (encrypted: string) => mockDecryptPromoCode(encrypted),
}));

const FAILURE_LOG =
  'Failed to decrypt a self-service promo credit category; skipping it. Check CREDIT_CATEGORIES_ENCRYPTION_KEY_V2 / CREDIT_CATEGORIES_ENCRYPTION_KEY.';

/**
 * Decrypting the whole self-service promo catalogue runs at module scope, so a
 * single undecryptable value used to throw while the module was being imported.
 * Because sign-in imports this module transitively, that made every native auth
 * route return 500. An undecryptable entry must instead be skipped and reported,
 * while the entries that did decrypt stay in the catalogue.
 */
describe('promoCreditCategories decryption failures', () => {
  test('keeps the entries that did decrypt and skips only the undecryptable one', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      decryptCalls.length = 0;
      failingCiphertext = undefined;
      let categories: readonly { credit_category: string }[] = [];
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        categories = require('./promoCreditCategories').promoCreditCategories;
      });

      // More than one entry exists, so the positive assertions below can only
      // pass if the non-failing entries were actually decrypted and kept.
      expect(decryptCalls.length).toBeGreaterThan(1);
      expect(failingCiphertext).toBeDefined();

      // The single failure is reported exactly once, not once per entry.
      const failureLogs = errorSpy.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes(FAILURE_LOG)
      );
      expect(failureLogs).toHaveLength(1);
      expect(failureLogs[0]?.[1]).toBeInstanceOf(Error);

      const creditCategories = categories.map(category => category.credit_category);
      // The offending ciphertext is the only one missing; every other encrypted
      // entry survives as its decrypted category.
      const decryptedCategories = creditCategories.filter(category =>
        category.startsWith('decrypted:')
      );
      expect(decryptedCategories).toHaveLength(decryptCalls.length - 1);
      for (const ciphertext of decryptCalls) {
        if (ciphertext === failingCiphertext) {
          expect(creditCategories).not.toContain(`decrypted:${ciphertext}`);
        } else {
          expect(creditCategories).toContain(`decrypted:${ciphertext}`);
        }
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});
