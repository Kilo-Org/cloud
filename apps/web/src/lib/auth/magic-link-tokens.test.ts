import { describe, it, expect, beforeEach } from '@jest/globals';
import { createMagicLinkToken, verifyAndConsumeMagicLinkToken } from './magic-link-tokens';
import { db } from '@/lib/drizzle';
import { sql } from 'drizzle-orm';

describe('Magic Link Tokens', () => {
  const testEmail = 'test@example.com';

  beforeEach(async () => {
    // Clean up test tokens before each test
    await db.execute(sql`DELETE FROM magic_link_tokens WHERE email = ${testEmail}`);
  });

  describe('createMagicLinkToken', () => {
    it('should create a magic link token with plaintext and hash', async () => {
      const result = await createMagicLinkToken(testEmail);

      expect(result).toBeDefined();
      expect(result.plaintext_token).toBeDefined();
      expect(result.token_hash).toBeDefined();
      expect(result.email).toBe(testEmail);
      expect(result.consumed_at).toBeNull();
      expect(result.expires_at).toBeDefined();
      expect(result.created_at).toBeDefined();

      // Verify plaintext token is 64 characters (32 bytes hex encoded)
      expect(result.plaintext_token).toHaveLength(64);

      // Verify token hash is 64 characters (SHA-256 hex encoded)
      expect(result.token_hash).toHaveLength(64);

      // Verify they are different
      expect(result.plaintext_token).not.toBe(result.token_hash);
    });

    it('should create tokens with future expiration', async () => {
      const result = await createMagicLinkToken(testEmail, 60);
      const expiresAt = new Date(result.expires_at);
      const now = new Date();

      // Should expire in approximately 60 minutes (1 hour)
      const minutesDiff = (expiresAt.getTime() - now.getTime()) / (1000 * 60);
      expect(minutesDiff).toBeGreaterThan(59.9);
      expect(minutesDiff).toBeLessThan(60.1);
    });

    it('should allow multiple tokens for the same email', async () => {
      const token1 = await createMagicLinkToken(testEmail);
      const token2 = await createMagicLinkToken(testEmail);

      expect(token1.plaintext_token).not.toBe(token2.plaintext_token);
      expect(token1.token_hash).not.toBe(token2.token_hash);
    });
  });

  describe('verifyAndConsumeMagicLinkToken', () => {
    it('should verify and consume a valid token', async () => {
      const created = await createMagicLinkToken(testEmail);
      const verified = await verifyAndConsumeMagicLinkToken(created.plaintext_token);

      expect(verified).toBeDefined();
      expect(verified?.email).toBe(testEmail);
      expect(verified?.consumed_at).toBeDefined();
      expect(verified?.token_hash).toBe(created.token_hash);
    });

    it('should return null for invalid token', async () => {
      const verified = await verifyAndConsumeMagicLinkToken('invalid-token-that-does-not-exist');
      expect(verified).toBeNull();
    });

    it('should not allow consuming the same token twice', async () => {
      const created = await createMagicLinkToken(testEmail);

      // First consumption should succeed
      const firstVerify = await verifyAndConsumeMagicLinkToken(created.plaintext_token);
      expect(firstVerify).toBeDefined();

      // Second consumption should fail
      const secondVerify = await verifyAndConsumeMagicLinkToken(created.plaintext_token);
      expect(secondVerify).toBeNull();
    });

    it('should not verify expired tokens', async () => {
      // Create a token with very short expiration (0.06 minutes = ~3.6 seconds)
      const created = await createMagicLinkToken(testEmail, 0.06);

      // Wait for it to expire
      await new Promise(resolve => setTimeout(resolve, 4000));

      const verified = await verifyAndConsumeMagicLinkToken(created.plaintext_token);
      expect(verified).toBeNull();
    });
  });
});
