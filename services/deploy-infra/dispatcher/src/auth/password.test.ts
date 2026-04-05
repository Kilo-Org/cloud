import { hashPassword, verifyPassword, type PasswordRecord } from './password';

describe('password hashing', () => {
  describe('hashPassword', () => {
    it('creates record with hash, salt, and createdAt', () => {
      const result = hashPassword('test-password');

      expect(result).toHaveProperty('passwordHash');
      expect(result).toHaveProperty('salt');
      expect(result).toHaveProperty('createdAt');

      // Hash should be PBKDF2 hex string (128 chars = 64 bytes)
      expect(result.passwordHash).toMatch(/^[a-f0-9]{128}$/);

      // Salt should be 16 bytes hex (32 chars)
      expect(result.salt).toMatch(/^[a-f0-9]{32}$/);

      // createdAt should be a reasonable timestamp
      expect(result.createdAt).toBeGreaterThan(Date.now() - 1000);
      expect(result.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it('produces unique salt for each call', () => {
      const result1 = hashPassword('same-password');
      const result2 = hashPassword('same-password');

      expect(result1.salt).not.toBe(result2.salt);
      // Different salts mean different hashes even for same password
      expect(result1.passwordHash).not.toBe(result2.passwordHash);
    });

    it('produces different hashes for different passwords', () => {
      const result1 = hashPassword('password-one');
      const result2 = hashPassword('password-two');

      expect(result1.passwordHash).not.toBe(result2.passwordHash);
    });
  });

  describe('verifyPassword', () => {
    it('returns true for correct password', () => {
      const password = 'my-secret-password';
      const record = hashPassword(password);

      const isValid = verifyPassword(password, record);

      expect(isValid).toBe(true);
    });

    it('returns false for incorrect password', () => {
      const record = hashPassword('correct-password');

      const isValid = verifyPassword('wrong-password', record);

      expect(isValid).toBe(false);
    });

    it('returns false for similar but different password', () => {
      const record = hashPassword('password123');

      expect(verifyPassword('password12', record)).toBe(false);
      expect(verifyPassword('password1234', record)).toBe(false);
      expect(verifyPassword('Password123', record)).toBe(false);
      expect(verifyPassword('', record)).toBe(false);
    });

    it('works with manual PasswordRecord', () => {
      // Create a record manually to ensure the format is correct
      const password = 'test-pass';
      const hashResult = hashPassword(password);

      const manualRecord: PasswordRecord = {
        passwordHash: hashResult.passwordHash,
        salt: hashResult.salt,
        createdAt: hashResult.createdAt,
      };

      expect(verifyPassword(password, manualRecord)).toBe(true);
      expect(verifyPassword('other-pass', manualRecord)).toBe(false);
    });
  });
});
