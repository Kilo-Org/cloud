import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  createMagicLinkToken,
  createSignInCode,
  deleteSignInCode,
  getMagicLinkUrl,
  verifyAndConsumeMagicLinkToken,
  verifyAndConsumeSignInCode,
} from './magic-link-tokens';
import { db } from '@/lib/drizzle';
import { sql, eq, and } from 'drizzle-orm';
import { magic_link_tokens } from '@kilocode/db/schema';
import { createHash } from 'crypto';

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

  describe('getMagicLinkUrl', () => {
    it('does not include email addresses in magic link URLs', async () => {
      const token = await createMagicLinkToken(testEmail);
      const url = new URL(getMagicLinkUrl(token));

      expect(url.pathname).toBe('/auth/verify-magic-link');
      expect(url.searchParams.get('token')).toBe(token.plaintext_token);
      expect(url.searchParams.has('email')).toBe(false);
      expect(url.toString()).not.toContain(encodeURIComponent(testEmail));
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

  describe('createSignInCode', () => {
    const rowFor = async (email: string) => {
      const rows = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, email));
      return rows[0];
    };

    it('returns a 6-digit zero-padded code and stores its hash', async () => {
      const code = await createSignInCode(testEmail);

      expect(code).toMatch(/^\d{6}$/);

      const row = await rowFor(testEmail);
      expect(row).toBeDefined();
      expect(row?.token_hash).not.toBe(
        createHash('sha256').update(`${testEmail}:${code}`).digest('hex')
      );
      expect(row?.purpose).toBe('sign_in_code');
      expect(row?.consumed_at).toBeNull();
      expect(row?.attempts).toBe(0);
    });

    it('lowercases the email before hashing and storing', async () => {
      const mixedCaseEmail = 'Test@Example.com';
      await db.execute(sql`DELETE FROM magic_link_tokens WHERE email = ${testEmail}`);

      await createSignInCode(mixedCaseEmail);
      const row = await rowFor(testEmail);

      expect(row).toBeDefined();
      expect(row?.email).toBe(testEmail);
      expect(row?.purpose).toBe('sign_in_code');
    });

    it('uses one live code and attempt budget for aliases of the same mailbox', async () => {
      const firstCode = await createSignInCode('te.st+first@gmail.com');
      const secondCode = await createSignInCode('test@gmail.com');

      expect(await verifyAndConsumeSignInCode('te.st+first@gmail.com', firstCode)).toBe('invalid');
      expect(await verifyAndConsumeSignInCode('test+second@googlemail.com', secondCode)).toBe('ok');
    });

    it('sets an expiry approximately 10 minutes out', async () => {
      await createSignInCode(testEmail);
      const row = await rowFor(testEmail);
      const minutesDiff = (new Date(row!.expires_at).getTime() - Date.now()) / (1000 * 60);

      expect(minutesDiff).toBeGreaterThan(9.9);
      expect(minutesDiff).toBeLessThan(10.1);
    });

    it('deletes prior unconsumed rows for the email so only one code is live', async () => {
      await createSignInCode(testEmail);
      const secondCode = await createSignInCode(testEmail);

      const rows = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));

      expect(rows).toHaveLength(1);
      expect(await verifyAndConsumeSignInCode(testEmail, secondCode)).toBe('ok');
    });

    it('does not delete already-consumed rows for the email', async () => {
      const firstCode = await createSignInCode(testEmail);
      await verifyAndConsumeSignInCode(testEmail, firstCode);

      await createSignInCode(testEmail);

      const rows = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(rows).toHaveLength(2);
    });

    it('does not delete or select browser magic-link tokens', async () => {
      const magicLink = await createMagicLinkToken(testEmail);
      const code = await createSignInCode(testEmail);

      expect(await verifyAndConsumeSignInCode(testEmail, code)).toBe('ok');
      expect(await verifyAndConsumeMagicLinkToken(magicLink.plaintext_token)).not.toBeNull();
    });

    it('serializes concurrent issuance so only the newest code remains live', async () => {
      const [firstCode, secondCode] = await Promise.all([
        createSignInCode(testEmail),
        createSignInCode(testEmail),
      ]);
      const rows = await db
        .select()
        .from(magic_link_tokens)
        .where(
          and(eq(magic_link_tokens.email, testEmail), eq(magic_link_tokens.purpose, 'sign_in_code'))
        );

      expect(rows).toHaveLength(1);
      const results = await Promise.all([
        verifyAndConsumeSignInCode(testEmail, firstCode),
        verifyAndConsumeSignInCode(testEmail, secondCode),
      ]);
      expect(results.toSorted()).toEqual(['invalid', 'ok']);
    });
  });

  describe('verifyAndConsumeSignInCode', () => {
    it('consumes a correct code and returns ok', async () => {
      const code = await createSignInCode(testEmail);

      const result = await verifyAndConsumeSignInCode(testEmail, code);
      expect(result).toBe('ok');

      const rows = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(rows[0]?.consumed_at).not.toBeNull();
    });

    it('is case-insensitive on email', async () => {
      const code = await createSignInCode('Test@Example.com');
      const result = await verifyAndConsumeSignInCode('TEST@EXAMPLE.COM', code);
      expect(result).toBe('ok');
    });

    it('increments attempts and returns invalid on wrong code', async () => {
      await createSignInCode(testEmail);

      const result = await verifyAndConsumeSignInCode(testEmail, '000000');
      expect(result).toBe('invalid');

      const rows = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(rows[0]?.attempts).toBe(1);
      expect(rows[0]?.consumed_at).toBeNull();
    });

    it('returns too_many_attempts on the 6th attempt even with the correct code', async () => {
      const code = await createSignInCode(testEmail);
      const wrongCode = code === '000000' ? '111111' : '000000';

      for (let i = 0; i < 5; i++) {
        const result = await verifyAndConsumeSignInCode(testEmail, wrongCode);
        expect(result).toBe('invalid');
      }

      const result = await verifyAndConsumeSignInCode(testEmail, code);
      expect(result).toBe('too_many_attempts');
    });

    it('never consumes a correct code once the attempt budget is exceeded (racing increments)', async () => {
      const code = await createSignInCode(testEmail);
      // Simulate concurrent wrong guesses racing the pre-check past the
      // budget: force attempts beyond the max directly.
      await db
        .update(magic_link_tokens)
        .set({ attempts: 6 })
        .where(eq(magic_link_tokens.email, testEmail));

      const result = await verifyAndConsumeSignInCode(testEmail, code);
      expect(result).not.toBe('ok');
      expect(result).toBe('too_many_attempts');

      const rows = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(rows[0]?.consumed_at).toBeNull();
    });

    it('returns invalid for an expired code', async () => {
      // Directly insert an already-expired row since createSignInCode always
      // sets a 10-minute expiry. created_at is backdated too, to satisfy the
      // check_expires_at_future constraint (expires_at > created_at).
      const code = '123456';
      const token_hash = createHash('sha256').update(`${testEmail}:${code}`).digest('hex');
      await db.insert(magic_link_tokens).values({
        token_hash,
        email: testEmail,
        purpose: 'sign_in_code',
        created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        expires_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });

      const result = await verifyAndConsumeSignInCode(testEmail, code);
      expect(result).toBe('invalid');
    });

    it('returns invalid for an already-consumed code', async () => {
      const code = await createSignInCode(testEmail);
      const first = await verifyAndConsumeSignInCode(testEmail, code);
      expect(first).toBe('ok');

      const second = await verifyAndConsumeSignInCode(testEmail, code);
      expect(second).toBe('invalid');
    });

    it('returns invalid when there is no code for the email', async () => {
      const result = await verifyAndConsumeSignInCode(testEmail, '123456');
      expect(result).toBe('invalid');
    });
  });

  describe('deleteSignInCode', () => {
    it('deletes only the matching sign-in code', async () => {
      const magicLink = await createMagicLinkToken(testEmail);
      const code = await createSignInCode(testEmail);

      await deleteSignInCode(testEmail, code);

      expect(await verifyAndConsumeSignInCode(testEmail, code)).toBe('invalid');
      expect(await verifyAndConsumeMagicLinkToken(magicLink.plaintext_token)).not.toBeNull();
    });
  });
});
