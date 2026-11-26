import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { auth_audit_logs } from '@kilocode/db/schema';
import * as drizzle from '@kilocode/web-shared/lib/drizzle';
import {
  auditAuthProcedure,
  auditAuthRoute,
  authAuditEmailHash,
  markAuthAuditLockout,
  recordAuthEvent,
  setAuthActionSinkForTest,
  type AuthActionEvent,
} from '@/lib/auth/auth-audit';

const { cleanupDbForTest, db } = drizzle;

const request = { ip: '203.0.113.9', route: '/api/auth/callback/google' };

let events: AuthActionEvent[];

beforeEach(() => {
  events = [];
  setAuthActionSinkForTest(event => events.push(event));
});

afterEach(async () => {
  setAuthActionSinkForTest(null);
  await cleanupDbForTest();
});

describe('authAuditEmailHash', () => {
  test('is a keyed, domain-separated hash of the normalized address', () => {
    const expected = createHmac('sha256', 'test-only-non-secret')
      .update('auth-audit-email:v1:someone@example.com')
      .digest('base64url');

    expect(authAuditEmailHash('  Someone+tag@Example.com ')).toBe(expected);
  });

  test('makes no hash, and stores none, when the key is empty, reporting that once', async () => {
    const captureException = jest.fn();
    await jest.isolateModulesAsync(async () => {
      jest.doMock('@kilocode/web-shared/lib/config.server', () => ({
        ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
        NEXTAUTH_SECRET: '',
      }));
      jest.doMock('@sentry/nextjs', () => ({
        ...jest.requireActual<object>('@sentry/nextjs'),
        captureException,
      }));
      // The same database client as the rest of the file, not a second pool.
      jest.doMock('@kilocode/web-shared/lib/drizzle', () => drizzle);
      // Loaded again inside the isolated registry so it reads the empty key.
      const unkeyed = await import('@/lib/auth/auth-audit');

      expect(unkeyed.authAuditEmailHash('someone@example.com')).toBeNull();
      await unkeyed.recordAuthEvent(request, {
        action: 'auth.sign_in',
        outcome: 'failure',
        method: 'google',
        failureReason: 'account_blocked',
        email: 'someone@example.com',
      });
    });

    const rows = await db.select().from(auth_audit_logs);
    expect(rows).toEqual([
      expect.objectContaining({ failure_reason: 'account_blocked', subject_email_hash: null }),
    ]);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { operation: 'auth_audit_email_hash_key' },
    });
  });
});

describe('recordAuthEvent', () => {
  test('writes a failure row and log line that hold the email only as its hash', async () => {
    await recordAuthEvent(request, {
      action: 'auth.sign_in',
      outcome: 'failure',
      method: 'google',
      failureReason: 'account_blocked',
      email: 'Someone@Example.com',
    });

    const rows = await db.select().from(auth_audit_logs);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'auth.sign_in',
        outcome: 'failure',
        user_id: null,
        method: 'google',
        failure_reason: 'account_blocked',
        subject_email_hash: authAuditEmailHash('someone@example.com'),
        metadata: null,
      }),
    ]);
    expect(events).toEqual([
      {
        event: 'auth_action',
        action: 'auth.sign_in',
        outcome: 'failure',
        userId: null,
        method: 'google',
        failureReason: 'account_blocked',
        auditLogId: rows[0]?.id,
        stored: true,
        persisted: true,
        ip: '203.0.113.9',
        route: '/api/auth/callback/google',
      },
    ]);
    const recorded = JSON.stringify({ rows, events }).toLowerCase();
    expect(recorded).not.toContain('someone');
    expect(recorded).not.toContain('example.com');
  });

  test('replaces a failure reason that is not a stable code', async () => {
    await recordAuthEvent(request, {
      action: 'auth.passkey.add',
      outcome: 'failure',
      userId: 'user-1',
      failureReason: 'Verification failed for someone@example.com',
    });

    const [row] = await db.select().from(auth_audit_logs);
    expect(row?.failure_reason).toBe('invalid_code_value');
    expect(events[0]?.failureReason).toBe('invalid_code_value');
  });

  test('keeps a refusal that names no subject out of the table, with one log line', async () => {
    await recordAuthEvent(request, {
      action: 'auth.device_auth.redeem',
      outcome: 'failure',
      method: 'device_code',
      failureReason: 'invalid_request',
    });

    expect(await db.select().from(auth_audit_logs)).toEqual([]);
    expect(events).toEqual([
      {
        event: 'auth_action',
        action: 'auth.device_auth.redeem',
        outcome: 'failure',
        userId: null,
        method: 'device_code',
        failureReason: 'invalid_request',
        auditLogId: null,
        stored: false,
        persisted: false,
        ip: '203.0.113.9',
        route: '/api/auth/callback/google',
      },
    ]);
  });

  test.each(['rate_limited', 'too_many_attempts', 'http_429'])(
    'keeps a %s refusal of a known account out of the table',
    async failureReason => {
      await recordAuthEvent(request, {
        action: 'auth.sign_in',
        outcome: 'failure',
        userId: 'user-1',
        email: 'someone@example.com',
        failureReason,
      });

      expect(await db.select().from(auth_audit_logs)).toEqual([]);
      expect(events).toEqual([
        expect.objectContaining({ userId: 'user-1', failureReason, stored: false }),
      ]);
    }
  );

  test('stores a refusal of a known account', async () => {
    await recordAuthEvent(request, {
      action: 'auth.passkey.add',
      outcome: 'failure',
      userId: 'user-1',
      failureReason: 'verification_failed',
    });

    expect(await db.select().from(auth_audit_logs)).toEqual([
      expect.objectContaining({ user_id: 'user-1', failure_reason: 'verification_failed' }),
    ]);
    expect(events).toEqual([expect.objectContaining({ stored: true, persisted: true })]);
  });

  test('keeps a success that names no subject out of the table, with one log line', async () => {
    await recordAuthEvent(request, { action: 'auth.device_auth.create', outcome: 'success' });

    expect(await db.select().from(auth_audit_logs)).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'auth.device_auth.create',
        stored: false,
        persisted: false,
      }),
    ]);
  });

  test('still emits the log line, flagged unpersisted, when the insert fails', async () => {
    // The insert runs in its own transaction, which bounds its statement time.
    const transaction = jest.spyOn(db, 'transaction').mockImplementationOnce(async () => {
      throw new Error('database unavailable');
    });
    try {
      await expect(
        recordAuthEvent(request, { action: 'auth.sign_out', outcome: 'success', userId: 'user-1' })
      ).resolves.toBeUndefined();
    } finally {
      transaction.mockRestore();
    }

    expect(events).toEqual([
      expect.objectContaining({
        action: 'auth.sign_out',
        outcome: 'success',
        userId: 'user-1',
        auditLogId: null,
        stored: true,
        persisted: false,
      }),
    ]);
  });

  test('answers without waiting on a blocked audit table, and gives up on the insert', async () => {
    const scheduled: (() => Promise<void>)[] = [];
    const captureException = jest.fn();
    // Another transaction holds the audit table, so an insert blocks.
    const lock = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = db.transaction(async tx => {
      await tx.execute(sql`LOCK TABLE auth_audit_logs IN ACCESS EXCLUSIVE MODE`);
      lock.resolve();
      await release.promise;
    });
    await lock.promise;
    let flushMs = 0;
    try {
      await jest.isolateModulesAsync(async () => {
        // Next's `after()`: the work runs once the response is sent, here when
        // the test flushes it.
        jest.doMock('@/lib/after-response', () => ({
          runAfterResponse: async (work: () => Promise<void>) => {
            scheduled.push(work);
          },
        }));
        jest.doMock('@sentry/nextjs', () => ({
          ...jest.requireActual<object>('@sentry/nextjs'),
          captureException,
        }));
        jest.doMock('@kilocode/web-shared/lib/drizzle', () => drizzle);
        // Loaded again inside the isolated registry so it schedules through the mock.
        const deferred = await import('@/lib/auth/auth-audit');
        deferred.setAuthActionSinkForTest(event => events.push(event));

        const response = await deferred.auditAuthRoute(
          request,
          { action: 'auth.sign_out', userId: 'user-1' },
          async () => Response.json({ ok: true })
        );
        expect(response.status).toBe(200);
        expect(scheduled).toHaveLength(1);
        expect(events).toEqual([]);

        const flushStarted = Date.now();
        await Promise.all(scheduled.map(work => work()));
        flushMs = Date.now() - flushStarted;
      });
    } finally {
      release.resolve();
      await holder;
    }

    // The statement timeout, not the lock holder, ended the insert.
    expect(flushMs).toBeLessThan(10_000);
    expect(events).toEqual([
      expect.objectContaining({ action: 'auth.sign_out', stored: true, persisted: false }),
    ]);
    expect(captureException).toHaveBeenCalledWith(expect.anything(), {
      tags: { operation: 'auth_audit_insert' },
      extra: { action: 'auth.sign_out' },
    });
    expect(await db.select().from(auth_audit_logs)).toEqual([]);
  });
});

describe('auditAuthRoute', () => {
  test('keeps a 429 of a known account out of the table whatever code it carries', async () => {
    const attempt = { action: 'auth.sign_in' as const, userId: 'user-1', method: 'email' };

    const response = await auditAuthRoute(request, attempt, async () =>
      Response.json({ error: 'CODE_SEND_REFUSED' }, { status: 429 })
    );

    expect(response.status).toBe(429);
    expect(await db.select().from(auth_audit_logs)).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        failureReason: 'code_send_refused',
        stored: false,
      }),
    ]);
  });

  test.each(['EMAIL_CODE_LOCKED', 'sign_in_method_code_locked'])(
    'stores a %s lockout once, for the wrong code that locked the account',
    async code => {
      const locked = async () => Response.json({ error: code }, { status: 429 });

      await auditAuthRoute(
        request,
        { action: 'auth.passkey.add', userId: 'user-1', lockout: true },
        locked
      );
      // Every later refusal while the account stays locked.
      await auditAuthRoute(request, { action: 'auth.passkey.add', userId: 'user-1' }, locked);
      await auditAuthRoute(request, { action: 'auth.passkey.add', userId: 'user-1' }, locked);

      expect(await db.select().from(auth_audit_logs)).toEqual([
        expect.objectContaining({ user_id: 'user-1', failure_reason: code.toLowerCase() }),
      ]);
      expect(events.map(event => event.stored)).toEqual([true, false, false]);
    }
  );

  test('stores the same refusal of a known account when it is not a 429', async () => {
    const attempt = { action: 'auth.sign_in' as const, userId: 'user-1', method: 'email' };

    await auditAuthRoute(request, attempt, async () =>
      Response.json({ error: 'CODE_SEND_REFUSED' }, { status: 403 })
    );

    expect(await db.select().from(auth_audit_logs)).toEqual([
      expect.objectContaining({ user_id: 'user-1', failure_reason: 'code_send_refused' }),
    ]);
  });
});

describe('auditAuthProcedure', () => {
  const lockedRefusal = () =>
    new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'SIGN_IN_METHOD_CODE_LOCKED' });

  test('stores a TOO_MANY_REQUESTS refusal only when marked as the locking attempt', async () => {
    const attempt = { action: 'auth.sign_in_method.link' as const, userId: 'user-1' };

    await expect(
      auditAuthProcedure({}, attempt, async () => {
        throw markAuthAuditLockout(lockedRefusal());
      })
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      auditAuthProcedure({}, attempt, async () => {
        throw lockedRefusal();
      })
    ).rejects.toBeInstanceOf(TRPCError);

    expect(await db.select().from(auth_audit_logs)).toEqual([
      expect.objectContaining({
        user_id: 'user-1',
        failure_reason: 'sign_in_method_code_locked',
      }),
    ]);
    expect(events.map(event => event.stored)).toEqual([true, false]);
  });
});
