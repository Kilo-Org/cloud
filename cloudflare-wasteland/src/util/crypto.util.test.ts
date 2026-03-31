import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken, deriveEncryptionKey } from './crypto.util';

const TEST_SECRET = 'test-wasteland-encryption-key-with-high-entropy-0xDEADBEEF';
const DIFFERENT_SECRET = 'different-secret-key-for-wrong-key-test-0xCAFEBABE';

describe('crypto.util', () => {
  describe('deriveEncryptionKey', () => {
    it('produces a CryptoKey usable for encrypt and decrypt', async () => {
      const key = await deriveEncryptionKey(TEST_SECRET);
      expect(key).toBeDefined();
      expect(key.type).toBe('secret');
      expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
      expect(key.usages).toContain('encrypt');
      expect(key.usages).toContain('decrypt');
    });

    it('derives the same key from the same secret', async () => {
      const key1 = await deriveEncryptionKey(TEST_SECRET);
      const key2 = await deriveEncryptionKey(TEST_SECRET);

      // Encrypt with key1, decrypt with key2 — should succeed if deterministic
      const encrypted = await encryptToken('determinism-check', key1);
      const decrypted = await decryptToken(encrypted, key2);
      expect(decrypted).toBe('determinism-check');
    });
  });

  describe('encryptToken / decryptToken', () => {
    it('round-trips correctly', async () => {
      const key = await deriveEncryptionKey(TEST_SECRET);
      const plaintext = 'dolt_token_abc123xyz';

      const encrypted = await encryptToken(plaintext, key);
      const decrypted = await decryptToken(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    it('produces valid base64 output', async () => {
      const key = await deriveEncryptionKey(TEST_SECRET);
      const encrypted = await encryptToken('test', key);

      // Should be valid base64
      expect(() => atob(encrypted)).not.toThrow();

      // base64 decoded should be at least 12 (IV) + 1 (ciphertext) + 16 (tag) bytes
      const decoded = atob(encrypted);
      expect(decoded.length).toBeGreaterThanOrEqual(29);
    });

    it('produces different ciphertexts for different plaintexts', async () => {
      const key = await deriveEncryptionKey(TEST_SECRET);

      const encrypted1 = await encryptToken('token-alpha', key);
      const encrypted2 = await encryptToken('token-beta', key);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('produces different ciphertexts for the same plaintext (random IV)', async () => {
      const key = await deriveEncryptionKey(TEST_SECRET);

      const encrypted1 = await encryptToken('same-token', key);
      const encrypted2 = await encryptToken('same-token', key);

      expect(encrypted1).not.toBe(encrypted2);

      // Both should still decrypt to the same value
      expect(await decryptToken(encrypted1, key)).toBe('same-token');
      expect(await decryptToken(encrypted2, key)).toBe('same-token');
    });

    it('fails to decrypt with a wrong key', async () => {
      const correctKey = await deriveEncryptionKey(TEST_SECRET);
      const wrongKey = await deriveEncryptionKey(DIFFERENT_SECRET);

      const encrypted = await encryptToken('secret-token', correctKey);

      await expect(decryptToken(encrypted, wrongKey)).rejects.toThrow();
    });

    it('handles empty string', async () => {
      const key = await deriveEncryptionKey(TEST_SECRET);

      const encrypted = await encryptToken('', key);
      expect(encrypted).toBeTruthy();

      const decrypted = await decryptToken(encrypted, key);
      expect(decrypted).toBe('');
    });

    it('handles long tokens', async () => {
      const key = await deriveEncryptionKey(TEST_SECRET);
      const longToken = 'x'.repeat(10_000);

      const encrypted = await encryptToken(longToken, key);
      const decrypted = await decryptToken(encrypted, key);

      expect(decrypted).toBe(longToken);
    });

    it('handles unicode content', async () => {
      const key = await deriveEncryptionKey(TEST_SECRET);
      const unicodeToken = 'token-with-emoji-\u{1F680}-and-cjk-\u4E16\u754C';

      const encrypted = await encryptToken(unicodeToken, key);
      const decrypted = await decryptToken(encrypted, key);

      expect(decrypted).toBe(unicodeToken);
    });

    it('rejects truncated ciphertext', async () => {
      const key = await deriveEncryptionKey(TEST_SECRET);
      const encrypted = await encryptToken('test', key);

      // Truncate the base64 to produce invalid ciphertext
      const truncated = encrypted.slice(0, 10);

      await expect(decryptToken(truncated, key)).rejects.toThrow();
    });

    it('rejects tampered ciphertext', async () => {
      const key = await deriveEncryptionKey(TEST_SECRET);
      const encrypted = await encryptToken('test', key);

      // Decode, flip a byte in the ciphertext area (after IV), re-encode
      const decoded = atob(encrypted);
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) {
        bytes[i] = decoded.charCodeAt(i);
      }
      // Flip a byte past the 12-byte IV
      bytes[14] ^= 0xff;
      let tampered = '';
      for (let i = 0; i < bytes.length; i++) {
        tampered += String.fromCharCode(bytes[i]);
      }
      tampered = btoa(tampered);

      await expect(decryptToken(tampered, key)).rejects.toThrow();
    });
  });
});
