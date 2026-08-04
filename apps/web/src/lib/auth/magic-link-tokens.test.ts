import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  createMagicLinkToken,
  createSignInCode,
  consumeSignInCode,
  commitSignInCode,
  deleteSignInCode,
  getMagicLinkUrl,
  releaseSignInCode,
  reserveSignInCode,
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

    it('returns a 6-digit zero-padded code, stores its hash, and returns a challenge ID', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);

      expect(code).toMatch(/^\d{6}$/);
      expect(challengeId).toBeDefined();
      expect(challengeId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );

      const row = await rowFor(testEmail);
      expect(row).toBeDefined();
      expect(row?.token_hash).not.toBe(
        createHash('sha256').update(`${testEmail}:${code}`).digest('hex')
      );
      expect(row?.purpose).toBe('sign_in_code');
      expect(row?.consumed_at).toBeNull();
      expect(row?.attempts).toBe(0);
      expect(row?.challenge_id).toBe(challengeId);
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
      const { code: firstCode, challengeId: firstChallenge } =
        await createSignInCode('te.st+first@gmail.com');
      const { code: secondCode, challengeId: secondChallenge } =
        await createSignInCode('test@gmail.com');

      expect(
        await verifyAndConsumeSignInCode('te.st+first@gmail.com', firstCode, firstChallenge)
      ).toBe('invalid');
      expect(
        await verifyAndConsumeSignInCode('test+second@googlemail.com', secondCode, secondChallenge)
      ).toBe('ok');
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
      const { code: secondCode, challengeId: secondChallenge } = await createSignInCode(testEmail);

      const rows = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));

      expect(rows).toHaveLength(1);
      expect(await verifyAndConsumeSignInCode(testEmail, secondCode, secondChallenge)).toBe('ok');
    });

    it('does not delete already-consumed rows for the email', async () => {
      const { code: firstCode, challengeId: firstChallenge } = await createSignInCode(testEmail);
      await verifyAndConsumeSignInCode(testEmail, firstCode, firstChallenge);

      await createSignInCode(testEmail);

      const rows = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(rows).toHaveLength(2);
    });

    it('does not delete or select browser magic-link tokens', async () => {
      const magicLink = await createMagicLinkToken(testEmail);
      const { code, challengeId } = await createSignInCode(testEmail);

      expect(await verifyAndConsumeSignInCode(testEmail, code, challengeId)).toBe('ok');
      expect(await verifyAndConsumeMagicLinkToken(magicLink.plaintext_token)).not.toBeNull();
    });

    it('serializes concurrent issuance so only the newest code remains live', async () => {
      const [
        { code: firstCode, challengeId: firstChallenge },
        { code: secondCode, challengeId: secondChallenge },
      ] = await Promise.all([createSignInCode(testEmail), createSignInCode(testEmail)]);
      const rows = await db
        .select()
        .from(magic_link_tokens)
        .where(
          and(eq(magic_link_tokens.email, testEmail), eq(magic_link_tokens.purpose, 'sign_in_code'))
        );

      expect(rows).toHaveLength(1);
      const results = await Promise.all([
        verifyAndConsumeSignInCode(testEmail, firstCode, firstChallenge),
        verifyAndConsumeSignInCode(testEmail, secondCode, secondChallenge),
      ]);
      expect(results.toSorted()).toEqual(['invalid', 'ok']);
    });
  });

  describe('verifyAndConsumeSignInCode', () => {
    it('consumes a correct code and returns ok', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);

      const result = await verifyAndConsumeSignInCode(testEmail, code, challengeId);
      expect(result).toBe('ok');

      const rows = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(rows[0]?.consumed_at).not.toBeNull();
    });

    it('is case-insensitive on email', async () => {
      const { code, challengeId } = await createSignInCode('Test@Example.com');
      const result = await verifyAndConsumeSignInCode('TEST@EXAMPLE.COM', code, challengeId);
      expect(result).toBe('ok');
    });

    it('increments attempts and returns invalid on wrong code', async () => {
      const { challengeId } = await createSignInCode(testEmail);

      const result = await verifyAndConsumeSignInCode(testEmail, '000000', challengeId);
      expect(result).toBe('invalid');

      const rows = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(rows[0]?.attempts).toBe(1);
      expect(rows[0]?.consumed_at).toBeNull();
    });

    it('returns too_many_attempts on the 6th attempt even with the correct code', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);
      const wrongCode = code === '000000' ? '111111' : '000000';

      for (let i = 0; i < 5; i++) {
        const result = await verifyAndConsumeSignInCode(testEmail, wrongCode, challengeId);
        expect(result).toBe('invalid');
      }

      const result = await verifyAndConsumeSignInCode(testEmail, code, challengeId);
      expect(result).toBe('too_many_attempts');
    });

    it('never consumes a correct code once the attempt budget is exceeded (racing increments)', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);
      // Simulate concurrent wrong guesses racing the pre-check past the
      // budget: force attempts beyond the max directly.
      await db
        .update(magic_link_tokens)
        .set({ attempts: 6 })
        .where(eq(magic_link_tokens.email, testEmail));

      const result = await verifyAndConsumeSignInCode(testEmail, code, challengeId);
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
      const { code, challengeId } = await createSignInCode(testEmail);
      const first = await verifyAndConsumeSignInCode(testEmail, code, challengeId);
      expect(first).toBe('ok');

      const second = await verifyAndConsumeSignInCode(testEmail, code, challengeId);
      expect(second).toBe('invalid');
    });

    it('returns invalid when there is no code for the email', async () => {
      const result = await verifyAndConsumeSignInCode(testEmail, '123456');
      expect(result).toBe('invalid');
    });
  });

  describe('reserveSignInCode / commitSignInCode / releaseSignInCode', () => {
    it('reserves a code without consuming it', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);

      const result = await reserveSignInCode(testEmail, code, challengeId);
      expect(result).toBe('ok');

      const [row] = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(row?.consumed_at).toBeNull();
      expect(row?.reserved_until).not.toBeNull();
    });

    it('commits a reserved code', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);
      const reserveResult = await reserveSignInCode(testEmail, code, challengeId);
      expect(reserveResult).toBe('ok');

      const committed = await commitSignInCode(testEmail, code, challengeId);
      expect(committed).toBe(true);

      const [row] = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(row?.consumed_at).not.toBeNull();
    });

    it('releases a reserved code without incrementing attempts', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);
      await reserveSignInCode(testEmail, code, challengeId);

      // Verify a wrong guess does NOT increment attempts
      const [before] = await db
        .select({ attempts: magic_link_tokens.attempts })
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(before?.attempts).toBe(0);

      await releaseSignInCode(testEmail, code, challengeId);

      const [after] = await db
        .select({
          attempts: magic_link_tokens.attempts,
          reserved_until: magic_link_tokens.reserved_until,
        })
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(after?.attempts).toBe(0);
      expect(after?.reserved_until).toBeNull();
    });

    it('released code remains usable (failed settlement does not cost attempts)', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);
      await reserveSignInCode(testEmail, code, challengeId);
      await releaseSignInCode(testEmail, code, challengeId);

      // Code should be usable again
      const result = await reserveSignInCode(testEmail, code, challengeId);
      expect(result).toBe('ok');

      // And should not have any attempts consumed
      const [row] = await db
        .select({ attempts: magic_link_tokens.attempts })
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(row?.attempts).toBe(0);
    });

    it('blocks a second reservation on the same code with in_progress', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);

      const first = await reserveSignInCode(testEmail, code, challengeId);
      expect(first).toBe('ok');

      const second = await reserveSignInCode(testEmail, code, challengeId);
      expect(second).toBe('in_progress');

      // The code remains unconsumed
      const [row] = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(row?.consumed_at).toBeNull();
    });

    it('two concurrent reservations yield exactly one ok', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);

      const results = await Promise.all([
        reserveSignInCode(testEmail, code, challengeId),
        reserveSignInCode(testEmail, code, challengeId),
      ]);
      const sorted = results.toSorted();
      expect(sorted).toEqual(['in_progress', 'ok']);
    });

    it('reservation becomes usable after expiry', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);

      await reserveSignInCode(testEmail, code, challengeId);

      // Force the reservation to expire
      await db
        .update(magic_link_tokens)
        .set({ reserved_until: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(magic_link_tokens.email, testEmail));

      const result = await reserveSignInCode(testEmail, code, challengeId);
      expect(result).toBe('ok');
    });

    it('commitSignInCode fails after reservation expires', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);
      await reserveSignInCode(testEmail, code, challengeId);

      // Force the reservation to expire
      await db
        .update(magic_link_tokens)
        .set({ reserved_until: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(magic_link_tokens.email, testEmail));

      const committed = await commitSignInCode(testEmail, code, challengeId);
      expect(committed).toBe(false);

      // Code should still be unconsumed
      const [row] = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(row?.consumed_at).toBeNull();
    });

    it('consumeSignInCode works without a reservation', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);
      await reserveSignInCode(testEmail, code, challengeId);

      // Force the reservation to expire
      await db
        .update(magic_link_tokens)
        .set({ reserved_until: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(magic_link_tokens.email, testEmail));

      // consumeSignInCode should still work without a live reservation
      const consumed = await consumeSignInCode(testEmail, code, challengeId);
      expect(consumed).toBe(true);

      const [row] = await db
        .select()
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(row?.consumed_at).not.toBeNull();
    });

    it('consumeSignInCode prevents a second consume', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);
      await reserveSignInCode(testEmail, code, challengeId);

      const first = await consumeSignInCode(testEmail, code, challengeId);
      expect(first).toBe(true);

      const second = await consumeSignInCode(testEmail, code, challengeId);
      expect(second).toBe(false);
    });

    describe('challenge-keyed budget isolation', () => {
      it('five wrong guesses against challenge A do not spend challenge B budget', async () => {
        const { code: codeA, challengeId: challengeA } = await createSignInCode(testEmail);
        const { code: codeB, challengeId: challengeB } =
          await createSignInCode('other@example.com');

        // Spend challenge A's budget with wrong guesses.
        const wrongCode = codeA === '000000' ? '111111' : '000000';
        for (let i = 0; i < 5; i++) {
          const result = await reserveSignInCode(testEmail, wrongCode, challengeA);
          expect(result).toBe('invalid');
        }

        // Challenge A is now exhausted.
        const exhausted = await reserveSignInCode(testEmail, wrongCode, challengeA);
        expect(exhausted).toBe('too_many_attempts');

        // Challenge B is untouched — a wrong guess succeeds (returns 'invalid',
        // not 'too_many_attempts', and doesn't find a row since there's a
        // different challenge).
        const bResult = await reserveSignInCode('other@example.com', wrongCode, challengeB);
        expect(bResult).toBe('invalid');

        // The correct code for B still verifies through verifyAndConsumeSignInCode
        // using the challenge.
        const verifyResult = await verifyAndConsumeSignInCode(
          'other@example.com',
          codeB,
          challengeB
        );
        expect(verifyResult).toBe('ok');
      });

      it('commitSignInCode scoped to challenge', async () => {
        const { code, challengeId } = await createSignInCode(testEmail);
        await reserveSignInCode(testEmail, code, challengeId);

        // Commit with the right challenge succeeds.
        const committed = await commitSignInCode(testEmail, code, challengeId);
        expect(committed).toBe(true);
      });

      it('commitSignInCode with wrong challenge fails', async () => {
        const { code, challengeId } = await createSignInCode(testEmail);
        await reserveSignInCode(testEmail, code, challengeId);

        // Commit with a different challenge fails.
        const committed = await commitSignInCode(
          testEmail,
          code,
          '00000000-0000-0000-0000-000000000000'
        );
        expect(committed).toBe(false);

        // Code should still be unconsumed.
        const [row] = await db
          .select()
          .from(magic_link_tokens)
          .where(eq(magic_link_tokens.email, testEmail));
        expect(row?.consumed_at).toBeNull();
      });

      it('releaseSignInCode scoped to challenge', async () => {
        const { code, challengeId } = await createSignInCode(testEmail);
        await reserveSignInCode(testEmail, code, challengeId);

        await releaseSignInCode(testEmail, code, challengeId);

        const [row] = await db
          .select({
            reserved_until: magic_link_tokens.reserved_until,
          })
          .from(magic_link_tokens)
          .where(eq(magic_link_tokens.email, testEmail));
        expect(row?.reserved_until).toBeNull();
      });

      it('consumeSignInCode scoped to challenge', async () => {
        const { code, challengeId } = await createSignInCode(testEmail);

        const consumed = await consumeSignInCode(testEmail, code, challengeId);
        expect(consumed).toBe(true);

        const [row] = await db
          .select()
          .from(magic_link_tokens)
          .where(eq(magic_link_tokens.email, testEmail));
        expect(row?.consumed_at).not.toBeNull();
      });

      it('challengeId is a UUID not derivable from the email or code', async () => {
        const first = await createSignInCode(testEmail);
        const second = await createSignInCode(testEmail);

        // Challenge IDs are unique across issuances.
        expect(first.challengeId).not.toBe(second.challengeId);
        // Challenge IDs are not the email.
        expect(first.challengeId).not.toBe(testEmail);
        // Challenge IDs are not the code.
        expect(first.challengeId).not.toBe(first.code);
      });

      it('R6: no-challenge wrong guesses do not lock out the challenge holder (same email)', async () => {
        const { code, challengeId } = await createSignInCode(testEmail);
        const wrongCode = code === '000000' ? '111111' : '000000';

        // Five wrong guesses without challengeId — each goes to the legacy
        // path, which filters for null challenge_id. Since the row has a
        // challenge_id, the legacy path never finds it and returns 'invalid'
        // without incrementing attempts.
        for (let i = 0; i < 5; i++) {
          const result = await reserveSignInCode(testEmail, wrongCode);
          expect(result).toBe('invalid');
        }

        // The row must have zero attempts — the no-challenge guesses did
        // not touch it.
        const [row] = await db
          .select({ attempts: magic_link_tokens.attempts })
          .from(magic_link_tokens)
          .where(eq(magic_link_tokens.email, testEmail));
        expect(row?.attempts).toBe(0);

        // The correct code with the real challengeId still succeeds.
        const verifyResult = await verifyAndConsumeSignInCode(testEmail, code, challengeId);
        expect(verifyResult).toBe('ok');
      });

      it('returns invalid for a challenge ID that matches no row', async () => {
        const { code } = await createSignInCode(testEmail);

        // Use a challenge ID that does not exist in the database.
        const result = await reserveSignInCode(
          testEmail,
          code,
          '00000000-0000-0000-0000-000000000000'
        );
        expect(result).toBe('invalid');

        // The existing row must remain untouched (no attempts, not consumed).
        const [row] = await db
          .select({
            attempts: magic_link_tokens.attempts,
            consumed_at: magic_link_tokens.consumed_at,
          })
          .from(magic_link_tokens)
          .where(eq(magic_link_tokens.email, testEmail));
        expect(row?.attempts).toBe(0);
        expect(row?.consumed_at).toBeNull();
      });
      it('legacy null-challenge row: email-keyed path still increments attempts', async () => {
        // Manually insert a row without challenge_id to simulate a legacy rollout row.
        const code = '999999';
        const token_hash = createHash('sha256').update(`${testEmail}:${code}`).digest('hex');
        await db.insert(magic_link_tokens).values({
          token_hash,
          email: testEmail,
          purpose: 'sign_in_code',
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          challenge_id: null,
        });

        // A wrong guess without challengeId hits the legacy path and increments attempts.
        const first = await reserveSignInCode(testEmail, '000000');
        expect(first).toBe('invalid');

        const [row] = await db
          .select({ attempts: magic_link_tokens.attempts })
          .from(magic_link_tokens)
          .where(eq(magic_link_tokens.email, testEmail));
        expect(row?.attempts).toBe(1);
      });
    });
  });

  describe('reservation lapse — one account, one session', () => {
    it('with the same code, two sequential settle-attempts produce one consumed code', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);

      // First: reserve, then consume unconditionally (simulating a lapse)
      const firstReserve = await reserveSignInCode(testEmail, code, challengeId);
      expect(firstReserve).toBe('ok');

      await consumeSignInCode(testEmail, code, challengeId);

      // Second attempt: code should be consumed, so reserve returns 'invalid'
      const secondReserve = await reserveSignInCode(testEmail, code, challengeId);
      expect(secondReserve).toBe('invalid');
    });

    it('settles once, consumes after a lapse, and creates one session across two attempts', async () => {
      const { code, challengeId } = await createSignInCode(testEmail);
      const settledAccounts: string[] = [];
      const issuedSessions: string[] = [];

      // 1. Reserve the code.
      const reserve = await reserveSignInCode(testEmail, code, challengeId);
      expect(reserve).toBe('ok');

      // Settlement is idempotent for an existing account. Model the completed
      // settlement before the reservation lapses, as the native route does.
      settledAccounts.push(testEmail);

      // 2. Force the reservation to expire (simulate mid-settlement timeout).
      await db
        .update(magic_link_tokens)
        .set({ reserved_until: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(magic_link_tokens.email, testEmail));

      // 3. Commit fails because the reservation has lapsed.
      const committed = await commitSignInCode(testEmail, code, challengeId);
      expect(committed).toBe(false);

      // Code must still be unconsumed (commit does not touch consumed_at on failure).
      const [afterCommit] = await db
        .select({ consumed_at: magic_link_tokens.consumed_at })
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(afterCommit?.consumed_at).toBeNull();

      // 4. Consume unconditionally — the user is legitimately settled.
      const consumed = await consumeSignInCode(testEmail, code, challengeId);
      expect(consumed).toBe(true);
      issuedSessions.push(testEmail);

      // Code is now marked as consumed.
      const [afterConsume] = await db
        .select({ consumed_at: magic_link_tokens.consumed_at })
        .from(magic_link_tokens)
        .where(eq(magic_link_tokens.email, testEmail));
      expect(afterConsume?.consumed_at).not.toBeNull();

      // 5. A second attempt cannot settle or issue another session.
      const secondReserve = await reserveSignInCode(testEmail, code, challengeId);
      expect(secondReserve).toBe('invalid');

      // The consumed code must not be re-usable.
      const secondConsume = await consumeSignInCode(testEmail, code, challengeId);
      expect(secondConsume).toBe(false);
      expect(settledAccounts).toEqual([testEmail]);
      expect(issuedSessions).toEqual([testEmail]);
    });
  });

  describe('deleteSignInCode', () => {
    it('deletes only the matching sign-in code', async () => {
      const magicLink = await createMagicLinkToken(testEmail);
      const { code, challengeId } = await createSignInCode(testEmail);

      await deleteSignInCode(testEmail, code);

      expect(await verifyAndConsumeSignInCode(testEmail, code, challengeId)).toBe('invalid');
      expect(await verifyAndConsumeMagicLinkToken(magicLink.plaintext_token)).not.toBeNull();
    });
  });
});
