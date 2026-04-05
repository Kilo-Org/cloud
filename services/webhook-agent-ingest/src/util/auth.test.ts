import { describe, it, expect } from 'vitest';
import { validateInternalApiKey } from './auth';

const TEST_SECRET = 'test-internal-api-secret';

describe('validateInternalApiKey', () => {
  describe('header validation', () => {
    it('should reject missing API key header', () => {
      const result = validateInternalApiKey(null, TEST_SECRET);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Missing internal API key');
      }
    });

    it('should reject empty API key header', () => {
      const result = validateInternalApiKey('', TEST_SECRET);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Missing internal API key');
      }
    });
  });

  describe('key validation', () => {
    it('should accept valid API key', () => {
      const result = validateInternalApiKey(TEST_SECRET, TEST_SECRET);

      expect(result.success).toBe(true);
    });

    it('should reject invalid API key', () => {
      const result = validateInternalApiKey('wrong-key', TEST_SECRET);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Invalid internal API key');
      }
    });
  });
});
