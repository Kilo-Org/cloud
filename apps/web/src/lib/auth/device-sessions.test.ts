import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { device_sessions, device_refresh_tokens, kilocode_users } from '@kilocode/db/schema';
import { and, eq, getTableName, isNotNull, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  cleanupExpiredDeviceRefreshTokens,
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

    async function readSession(sessionId: string) {
      const [session] = await db
        .select()
        .from(device_sessions)
        .where(eq(device_sessions.id, sessionId));
      return session!;
    }

    // Wait until `count` rotations are blocked on the session row lock. The
    // wait is a Postgres lock, not a timer, so fake timers cannot drive it:
    // poll pg_stat_activity until the waiters are visible.
    async function waitForSessionLockWaiters(count: number) {
      for (let attempt = 0; attempt < 200; attempt++) {
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
        if (blocked >= count) {
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`expected ${count} rotations to wait on the session row lock`);
    }

    // Hold the session row lock in a separate transaction. `inLock` runs
    // under the lock after `release` is called, then the transaction commits.
    async function holdSessionLock(
      sessionId: string,
      inLock: (tx: DrizzleTransaction) => Promise<void> = async () => {}
    ) {
      const gate = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const done = db.transaction(async tx => {
        await tx
          .select()
          .from(device_sessions)
          .where(eq(device_sessions.id, sessionId))
          .for('update');
        held.resolve();
        await gate.promise;
        await inLock(tx);
      });
      await held.promise;
      return { release: () => gate.resolve(), done };
    }

    test('replay after the session chain advanced revokes the session', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      // The client rotates twice, so the chain has moved past the first token.
      const first = await rotateRefreshToken(refreshToken);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const second = await rotateRefreshToken(first.refreshToken);
      expect(second.ok).toBe(true);

      // A use of the first token now is a replay: refuse and revoke.
      const replay = await rotateRefreshToken(refreshToken);
      expect(replay).toEqual({ ok: false, error: 'INVALID_REFRESH_TOKEN' });

      const session = await readSession(sessionId);
      expect(session.revoked_at).not.toBeNull();
      expect(session.revoked_reason).toBe('refresh_reuse_detected');
    });

    test('a lost rotation response is retried with the consumed token without revocation', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      // The server commits the rotation, but the client never stores the
      // response (suspended mid-request, dropped connection, keychain write
      // failure) and retries with the token it still holds.
      const lost = await rotateRefreshToken(refreshToken);
      expect(lost.ok).toBe(true);
      if (!lost.ok) return;

      const retry = await rotateRefreshToken(refreshToken);
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.refreshToken).not.toBe(lost.refreshToken);
      expect((await readSession(sessionId)).revoked_at).toBeNull();

      // The session keeps one live refresh token: the one the client stored.
      const live = await db
        .select()
        .from(device_refresh_tokens)
        .where(
          and(
            eq(device_refresh_tokens.device_session_id, sessionId),
            isNull(device_refresh_tokens.consumed_at)
          )
        );
      expect(live).toHaveLength(1);

      // The retried pair keeps rotating.
      const next = await rotateRefreshToken(retry.refreshToken);
      expect(next.ok).toBe(true);
      expect((await readSession(sessionId)).revoked_at).toBeNull();
    });

    test('a use of the retired pair from a lost rotation revokes the session', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      const lost = await rotateRefreshToken(refreshToken);
      expect(lost.ok).toBe(true);
      if (!lost.ok) return;
      const retry = await rotateRefreshToken(refreshToken);
      expect(retry.ok).toBe(true);

      // Two holders of the session diverged: refuse and revoke.
      const replay = await rotateRefreshToken(refreshToken);
      expect(replay).toEqual({ ok: false, error: 'INVALID_REFRESH_TOKEN' });
      expect((await readSession(sessionId)).revoked_reason).toBe('refresh_reuse_detected');
    });

    test('a second presentation of a recovered token revokes the session without a new row', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      const lost = await rotateRefreshToken(refreshToken);
      expect(lost.ok).toBe(true);
      if (!lost.ok) return;

      // First presentation after the response was lost: recovers.
      const retry = await rotateRefreshToken(refreshToken);
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;

      const rowsAfterRecovery = await db
        .select()
        .from(device_refresh_tokens)
        .where(eq(device_refresh_tokens.device_session_id, sessionId));

      // A later presentation of the same token is a replay: refuse, revoke,
      // and issue no replacement row.
      const again = await rotateRefreshToken(refreshToken);
      expect(again).toEqual({ ok: false, error: 'INVALID_REFRESH_TOKEN' });
      expect((await readSession(sessionId)).revoked_reason).toBe('refresh_reuse_detected');

      const rowsAfterReplay = await db
        .select()
        .from(device_refresh_tokens)
        .where(eq(device_refresh_tokens.device_session_id, sessionId));
      expect(rowsAfterReplay).toHaveLength(rowsAfterRecovery.length);
    });

    test('the consume time of a recovered token does not move', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      const lost = await rotateRefreshToken(refreshToken);
      expect(lost.ok).toBe(true);
      if (!lost.ok) return;

      // Pin the consume stamp to an exact value inside the grace window. A
      // recovery that restamps the row would replace this value with the
      // request's read time and the two reads would differ.
      const pinnedConsumeAt = new Date(Date.now() - 60_000).toISOString();
      await db
        .update(device_refresh_tokens)
        .set({ consumed_at: pinnedConsumeAt })
        .where(
          eq(
            device_refresh_tokens.token_hash,
            createHash('sha256').update(refreshToken).digest('hex')
          )
        );

      const retry = await rotateRefreshToken(refreshToken);
      expect(retry.ok).toBe(true);

      const afterRecovery = await db
        .select({ consumed_at: device_refresh_tokens.consumed_at })
        .from(device_refresh_tokens)
        .where(
          eq(
            device_refresh_tokens.token_hash,
            createHash('sha256').update(refreshToken).digest('hex')
          )
        );
      expect(new Date(afterRecovery[0]!.consumed_at!).getTime()).toBe(
        new Date(pinnedConsumeAt).getTime()
      );
    });

    test('a stale request that read the token before the winning consume retires nothing', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);
      const deliveredToken = `delivered-${Date.now()}`;

      // The client times out and retries. The retry wins the session lock,
      // consumes the token, and delivers a new pair. The aborted request read
      // the token first but reaches the lock after the retry commits.
      const lock = await holdSessionLock(sessionId, async tx => {
        await tx
          .update(device_refresh_tokens)
          .set({ consumed_at: sql`clock_timestamp()` })
          .where(
            eq(
              device_refresh_tokens.token_hash,
              createHash('sha256').update(refreshToken).digest('hex')
            )
          );
        await tx.insert(device_refresh_tokens).values({
          token_hash: createHash('sha256').update(deliveredToken).digest('hex'),
          device_session_id: sessionId,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        });
      });
      const staleRequest = rotateRefreshToken(refreshToken);
      try {
        await waitForSessionLockWaiters(1);
      } finally {
        lock.release();
        await lock.done;
      }

      expect(await staleRequest).toEqual({ ok: false, error: 'INVALID_REFRESH_TOKEN' });
      expect((await readSession(sessionId)).revoked_at).toBeNull();

      // The delivered pair stays live and keeps rotating.
      const next = await rotateRefreshToken(deliveredToken);
      expect(next.ok).toBe(true);
      expect((await readSession(sessionId)).revoked_at).toBeNull();
    });

    test('a retry that gets the session lock after the lost rotation still recovers', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      // The first request waits on the lock, the client times out and
      // retries, and the retry waits behind it. The first request consumes
      // the token, but its response is lost.
      const lock = await holdSessionLock(sessionId);
      const first = rotateRefreshToken(refreshToken);
      let retryRequest = first;
      try {
        await waitForSessionLockWaiters(1);
        retryRequest = rotateRefreshToken(refreshToken);
        await waitForSessionLockWaiters(2);
      } finally {
        lock.release();
        await lock.done;
      }

      expect((await first).ok).toBe(true);
      const retry = await retryRequest;
      expect(retry.ok).toBe(true);
      expect((await readSession(sessionId)).revoked_at).toBeNull();
      if (!retry.ok) return;

      // The pair the client stored keeps rotating.
      const next = await rotateRefreshToken(retry.refreshToken);
      expect(next.ok).toBe(true);
      expect((await readSession(sessionId)).revoked_at).toBeNull();
    });

    test('a consumed token outside the lost-rotation grace revokes the session', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      const lost = await rotateRefreshToken(refreshToken);
      expect(lost.ok).toBe(true);

      // Move the consume outside the 24-hour grace.
      await db
        .update(device_refresh_tokens)
        .set({ consumed_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })
        .where(
          and(
            eq(device_refresh_tokens.device_session_id, sessionId),
            isNotNull(device_refresh_tokens.consumed_at)
          )
        );

      const replay = await rotateRefreshToken(refreshToken);
      expect(replay).toEqual({ ok: false, error: 'INVALID_REFRESH_TOKEN' });
      expect((await readSession(sessionId)).revoked_reason).toBe('refresh_reuse_detected');
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
        // recheck until the revoke commits, so wait until the rotation is
        // observed waiting on the session row lock inside its transaction.
        await waitForSessionLockWaiters(1);

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

  describe('cleanupExpiredDeviceRefreshTokens', () => {
    test('deletes expired refresh tokens and keeps live ones', async () => {
      const sessionId = await createDeviceSession({ userId: testUserId });
      const { refreshToken } = await issueSessionCredentials(fakeUser, sessionId);

      // An expired row alongside the live one.
      const expiredHash = createHash('sha256').update('expired-token').digest('hex');
      await db.insert(device_refresh_tokens).values({
        token_hash: expiredHash,
        device_session_id: sessionId,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });

      const deleted = await cleanupExpiredDeviceRefreshTokens();

      expect(deleted).toBeGreaterThanOrEqual(1);

      const remaining = await db
        .select({ token_hash: device_refresh_tokens.token_hash })
        .from(device_refresh_tokens)
        .where(eq(device_refresh_tokens.device_session_id, sessionId));
      expect(remaining.map(row => row.token_hash)).toEqual([
        createHash('sha256').update(refreshToken).digest('hex'),
      ]);
    });
  });
});
