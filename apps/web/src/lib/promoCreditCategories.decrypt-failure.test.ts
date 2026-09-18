import { describe, expect, jest, test } from '@jest/globals';

const mockDecryptPromoCode = jest.fn((_encrypted: string): string => {
  throw new Error('Unsupported state or unable to authenticate data');
});

jest.mock('@/lib/promoCreditEncryption', () => ({
  decryptPromoCode: (encrypted: string) => mockDecryptPromoCode(encrypted),
}));

/**
 * Decrypting the whole self-service promo catalogue runs at module scope, so a
 * single undecryptable value used to throw while the module was being imported.
 * Because sign-in imports this module transitively, that made every native auth
 * route return 500. An undecryptable entry must instead be skipped and reported.
 */
describe('promoCreditCategories decryption failures', () => {
  test('an undecryptable promo entry does not take the catalogue down', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let categories: readonly { credit_category: string }[] = [];
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        categories = require('./promoCreditCategories').promoCreditCategories;
      });

      expect(mockDecryptPromoCode).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to decrypt a self-service promo credit category'),
        expect.any(Error)
      );
      expect(categories.length).toBeGreaterThan(0);
      for (const category of categories) {
        expect(category.credit_category).toBeTruthy();
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});
