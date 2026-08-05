import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { device_sessions, device_refresh_tokens, kilocode_users } from '@kilocode/db/schema';
import { eq, getTableName, sql } from 'drizzle-orm';
import {
  createDeviceSession,
  issueSessionCredentials,
  rotateRefreshToken,
  revokeDeviceSession,
} from './device-sessions';
import type { User } from '@kilocode/db/schema';

describe('device-sessions', () => {
  const testUserId = 'test-user-ds-' + Date.now();
  const testUserEmail = `test-ds-${Date.now()}@example.com`;

  let fakeUser: User;

  beforeEach(async () => {
    await db.insert(kilocode_users).values({
      id: testUserId,
      google_user_email: testUserEmail,
      google_user_name: 'Test User',
      google_user_image_url: 'https://example.com/avatar.jpg',
      stripe_customer_id: 'cus_test',
    });
    fakeUser = {
      id: testUserId,
      google_user_email: testUserEmail,
      google_user_name: 'Test User',
      google_user_image_url: 'https://example.com/avatar.jpg',
      api_token_pepper: undefined,
    } as unknown as User;
  });

  afterEach(async () => {
    // Cascade from kilocode_users cleans device_sessions → device_refresh_tokens.
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUserId));
  });

  describe('createDeviceSession', () => {
    test('creates a session and returns its ID', async () => {
      const sessionId = await createDeviceSession({
        userId: testUserId,
        userAgent: 'test-agent',
      });

      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);

      const [row] = await db
        .select()
        .from(device_sessions)
        .where(eq(device_sessions.id, sessionId));

      expect(row).toBeDefined();
      expect(row!.kilo_user_id).toBe(testUserId);
      expect(row!.user_agent).toBe('test-agent');
      expect(row!.revoked_at).toBeNull();
    });
  });

  describe('issueSessionCredentials', () => {
    test('returns a one-hour access token and a refresh token', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const result = await issueSessionCredentials(fakeUser, sessionId);

      expect(result.token).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.expiresIn).toBe(60 * 60); // one hour

      // Verify refresh token was stored
      const tokens = await db
        .select()
        .from(device_refresh_tokens)
        .where(eq(device_refresh_tokens.device_session_id, sessionId));

      expect(tokens.length).toBe(1);
      expect(new Date(tokens[0]!.expires_at).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('rotateRefreshToken', () => {
    test('happy path: rotates and returns a new pair', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      const result = await rotateRefreshToken(refreshToken);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.token).toBeDefined();
        expect(result.refreshToken).toBeDefined();
        expect(result.refreshToken).not.toBe(refreshToken);
        expect(result.expiresIn).toBe(60 * 60);

        // Old refresh token is consumed
        const tokens = await db
          .select()
          .from(device_refresh_tokens)
          .where(eq(device_refresh_tokens.device_session_id, sessionId));

        const oldToken = tokens.find(t => t.consumed_at !== null);
        expect(oldToken).toBeDefined();

        // New refresh token exists
        expect(tokens.length).toBe(2);
      }
    });

    test('unknown refresh token returns INVALID_REFRESH_TOKEN without revocation', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      await issueSessionCredentials(fakeUser, sessionId);

      const result = await rotateRefreshToken('bogus-token-12345');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('INVALID_REFRESH_TOKEN');
      }

      // Session must NOT be revoked
      const [session] = await db
        .select()
        .from(device_sessions)
        .where(eq(device_sessions.id, sessionId));
      expect(session!.revoked_at).toBeNull();
    });

    test('reused refresh token revokes the session', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      // First rotation succeeds
      const first = await rotateRefreshToken(refreshToken);
      expect(first.ok).toBe(true);

      // Second use of the SAME refresh token must fail and revoke
      const second = await rotateRefreshToken(refreshToken);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error).toBe('INVALID_REFRESH_TOKEN');
      }

      // Session must be revoked with the right reason
      const [session] = await db
        .select()
        .from(device_sessions)
        .where(eq(device_sessions.id, sessionId));
      expect(session!.revoked_at).not.toBeNull();
      expect(session!.revoked_reason).toBe('refresh_reuse_detected');
    });

    test('refresh for a revoked session returns SESSION_REVOKED', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      await revokeDeviceSession(sessionId, 'test-revocation');

      const result = await rotateRefreshToken(refreshToken);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('SESSION_REVOKED');
      }
    });

    test('concurrent revocation during rotation is refused and issues no replacement pair', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      // Real concurrency: run the revoke as a separate transaction that takes
      // the session row lock and stays open. Then start the rotation: its
      // pre-transaction checks read the pre-revoke state, and its
      // in-transaction `FOR UPDATE` recheck blocks on the held row lock. We
      // commit the revoke only after the rotation is observed blocked, so the
      // recheck under the lock is what must refuse and no replacement pair can
      // be issued after the revoke wins.
      let signalLockHeld: () => void = () => {};
      const lockHeld = new Promise<void>(resolve => {
        signalLockHeld = resolve;
      });
      let releaseRevoke: () => void = () => {};
      const revokeGate = new Promise<void>(resolve => {
        releaseRevoke = resolve;
      });

      const revokeTx = db.transaction(async tx => {
        await tx
          .update(device_sessions)
          .set({
            revoked_at: new Date().toISOString(),
            revoked_reason: 'concurrent-revoke-test',
          })
          .where(eq(device_sessions.id, sessionId));
        signalLockHeld();
        await revokeGate;
      });

      try {
        // Wait until the revoke transaction holds the session row lock.
        await lockHeld;

        // Start the rotation while the revoke is still uncommitted.
        const rotatePromise = rotateRefreshToken(refreshToken);

        // Deterministic barrier: the rotation cannot pass its `FOR UPDATE`
        // recheck until the revoke commits, so poll until the rotation is
        // observed waiting on the session row lock inside its transaction.
        let rotationBlocked = false;
        for (let attempt = 0; attempt < 200 && !rotationBlocked; attempt++) {
          const {
            rows: [{ blocked }],
          } = await db.execute<{ blocked: number }>(sql`
            SELECT count(*)::int AS blocked
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND state = 'active'
              AND wait_event_type = 'Lock'
              AND query ILIKE '%device_sessions%'
          `);
          rotationBlocked = blocked > 0;
          if (!rotationBlocked) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        expect(rotationBlocked).toBe(true);

        // Commit the revoke; the rotation's locked recheck then refuses.
        releaseRevoke();

        const [result] = await Promise.all([rotatePromise, revokeTx]);

        // The rotation must refuse instead of issuing a replacement pair.
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBe('SESSION_REVOKED');
        }

        // No replacement pair was issued: the old token is not consumed.
        const tokens = await db
          .select()
          .from(device_refresh_tokens)
          .where(eq(device_refresh_tokens.device_session_id, sessionId));
        expect(tokens).toHaveLength(1);
        expect(tokens[0]!.consumed_at).toBeNull();

        // The session is revoked.
        const [session] = await db
          .select()
          .from(device_sessions)
          .where(eq(device_sessions.id, sessionId));
        expect(session!.revoked_at).not.toBeNull();
      } finally {
        // Always commit the revoke so the held row lock is released, even when
        // an assertion fails. This keeps the afterEach cleanup unblocked.
        releaseRevoke();
        await revokeTx.catch(() => {});
      }
    });

    test('refresh for a blocked user returns USER_BLOCKED', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      // Block the user
      await db
        .update(kilocode_users)
        .set({ blocked_reason: 'manual block' })
        .where(eq(kilocode_users.id, testUserId));

      const result = await rotateRefreshToken(refreshToken);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('USER_BLOCKED');
      }
    });

    test('unblock and retry: blocked refresh does not consume token, retry succeeds after unblock', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      // Block the user
      await db
        .update(kilocode_users)
        .set({ blocked_reason: 'manual block' })
        .where(eq(kilocode_users.id, testUserId));

      // Attempt refresh while blocked — must refuse but NOT consume
      const blocked = await rotateRefreshToken(refreshToken);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.error).toBe('USER_BLOCKED');
      }

      // Verify the token is NOT consumed
      const [tokenAfterBlock] = await db
        .select()
        .from(device_refresh_tokens)
        .where(eq(device_refresh_tokens.device_session_id, sessionId));
      expect(tokenAfterBlock!.consumed_at).toBeNull();

      // Unblock the user
      await db
        .update(kilocode_users)
        .set({ blocked_reason: null })
        .where(eq(kilocode_users.id, testUserId));

      // Retry with the same token — must succeed
      const unblocked = await rotateRefreshToken(refreshToken);
      expect(unblocked.ok).toBe(true);
      if (unblocked.ok) {
        expect(unblocked.token).toBeDefined();
        expect(unblocked.refreshToken).not.toBe(refreshToken);
      }

      // Verify session is NOT revoked (no false reuse detection)
      const [session] = await db
        .select()
        .from(device_sessions)
        .where(eq(device_sessions.id, sessionId));
      expect(session!.revoked_at).toBeNull();
    });

    test('each rotation issues a fresh 30-day refresh token', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      const result = await rotateRefreshToken(refreshToken);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The new refresh token must have a 30-day expiry
        const tokens = await db
          .select()
          .from(device_refresh_tokens)
          .where(eq(device_refresh_tokens.device_session_id, sessionId));

        const newToken = tokens.find(t => t.consumed_at === null);
        expect(newToken).toBeDefined();
        if (newToken) {
          const expiresIn = new Date(newToken.expires_at).getTime() - Date.now();
          const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
          expect(expiresIn).toBeGreaterThan(thirtyDaysMs - 5000); // within 5s
          expect(expiresIn).toBeLessThan(thirtyDaysMs + 5000);
        }
      }
    });

    test('replacement issuance failure rolls back the consume and keeps the old token usable', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      // Force the replacement refresh-token insert to fail inside the rotation
      // transaction. The real transaction then rolls back the consume.
      const originalTransaction = db.transaction.bind(db);
      const transactionSpy = jest.spyOn(db, 'transaction').mockImplementation((async (
        callback: (tx: unknown) => unknown
      ) => {
        return originalTransaction(async tx => {
          const originalInsert = tx.insert.bind(tx);
          tx.insert = table => {
            if (getTableName(table) === getTableName(device_refresh_tokens)) {
              throw new Error('synthetic refresh issuance failure');
            }
            return originalInsert(table);
          };
          return callback(tx);
        });
      }) as unknown as typeof db.transaction);

      try {
        await expect(rotateRefreshToken(refreshToken)).rejects.toThrow(
          'synthetic refresh issuance failure'
        );
      } finally {
        transactionSpy.mockRestore();
      }

      // The old token must NOT be consumed by the failed rotation.
      const tokensAfterFailure = await db
        .select()
        .from(device_refresh_tokens)
        .where(eq(device_refresh_tokens.device_session_id, sessionId));
      expect(tokensAfterFailure).toHaveLength(1);
      expect(tokensAfterFailure[0]!.consumed_at).toBeNull();

      // The session must not be revoked by the failed rotation.
      const [sessionAfterFailure] = await db
        .select()
        .from(device_sessions)
        .where(eq(device_sessions.id, sessionId));
      expect(sessionAfterFailure!.revoked_at).toBeNull();

      // The same refresh token must now rotate successfully — proves recovery.
      const retry = await rotateRefreshToken(refreshToken);
      expect(retry.ok).toBe(true);
      if (retry.ok) {
        expect(retry.refreshToken).not.toBe(refreshToken);
      }
    });
  });
});
