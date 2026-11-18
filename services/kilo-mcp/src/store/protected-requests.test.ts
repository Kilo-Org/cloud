/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { totpCode } from '../otp/totp';
import { createMcpHandler } from '../index';
import type { ForwardedAuth } from '../types';
import {
  KiloMcpOAuthStore,
  MAX_OTP_ATTEMPTS,
  MAX_OTP_FAILURES,
  OTP_LOCKOUT_SECONDS,
  PROTECTED_REQUEST_TTL_SECONDS,
} from './oauth-store';

// Same in-memory/DO pattern as oauth-store.test.ts: a
// fake `DurableObjectStorage` whose `sql.exec` delegates to a real `node:sqlite`
// database, so these tests run the REAL drizzle durable-sqlite driver, the REAL
// generated migration SQL, and real SQLite semantics inside plain node vitest.
type CursorRow = Record<string, unknown>;

function toSqliteParam(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as string | number | bigint | Uint8Array | null;
}

function sqlExec(db: DatabaseSync, query: string, ...params: unknown[]) {
  const rows = db.prepare(query).all(...params.map(toSqliteParam)) as CursorRow[];
  const arrays = rows.map(row => Object.values(row));
  let index = 0;
  const iterator = {
    next: (): IteratorResult<CursorRow> =>
      index < rows.length
        ? { value: rows[index++], done: false }
        : { value: undefined as never, done: true },
  };
  return {
    toArray: () => rows,
    one: () => rows[0],
    raw: () => ({ toArray: () => arrays, one: () => arrays[0] }),
    next: () => iterator.next(),
    [Symbol.iterator]: () => iterator,
  };
}

/** A `DurableObjectState`-shaped fake for constructing the DO under test. */
function createFakeDoState(db: DatabaseSync) {
  const kv = new Map<string, unknown>();
  return {
    waitUntil: (_promise: Promise<unknown>) => {},
    storage: {
      sql: {
        exec: (query: string, ...params: unknown[]) => sqlExec(db, query, ...params),
      },
      transactionSync: <T>(callback: () => T): T => {
        db.exec('BEGIN');
        try {
          const result = callback();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
      getAlarm: async () => null as number | Date | null,
      setAlarm: async (_time: number | Date | string) => {},
    },
    blockConcurrencyWhile: <T>(callback: () => Promise<T>): Promise<T> => callback(),
  };
}

const NOW = '2026-09-16T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
/** NOW + PROTECTED_REQUEST_TTL_SECONDS (5 minutes). */
const AFTER_REQUEST_TTL = '2026-09-16T12:06:00.000Z';

/** A code that is guaranteed not to equal `code`, to exercise the wrong-code path. */
function wrongCodeFor(code: string): string {
  return code.startsWith('0') ? `1${code.slice(1)}` : `0${code.slice(1)}`;
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function rowFor(db: DatabaseSync, table: string, column: string, value: string) {
  return db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).get(value) as CursorRow;
}

describe('protected requests and OTP claims (real drizzle durable-sqlite over node:sqlite)', () => {
  let db: DatabaseSync;
  let store: InstanceType<typeof KiloMcpOAuthStore>;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    store = new KiloMcpOAuthStore(createFakeDoState(db) as never, {} as never);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Enrol `kiloUserId` and return the one secret the store keeps for them. The
   * enrollment is completed the way the picker completes it — the code that
   * answers `ensureAuthenticator` is confirmed with `confirmAuthenticator` —
   * because the store treats a row that never proved possession as unusable.
   */
  async function enroll(kiloUserId = 'admin-1'): Promise<string> {
    const { secret } = await store.ensureAuthenticator(kiloUserId, NOW);
    const confirmed = await store.confirmAuthenticator(
      kiloUserId,
      await totpCode(secret, NOW_MS),
      NOW
    );
    if (!confirmed) throw new Error('enrollment code did not verify');
    return secret;
  }

  /** A reviewed guarded call bound to the session that created it. */
  function createRequest(overrides: Partial<{ sessionId: string; kiloUserId: string }> = {}) {
    return store.createProtectedRequest({
      sessionId: 'session-1',
      kiloUserId: 'admin-1',
      clientId: 'client-1',
      path: 'organizations.admin.list',
      kind: 'admin',
      inputJson: '{"limit":10}',
      nowIso: NOW,
      ...overrides,
    });
  }

  function claim(
    id: string,
    code: string,
    overrides: Partial<{ sessionId: string; kiloUserId: string; nowIso: string }> = {}
  ) {
    return store.verifyOtpAndClaim({
      id,
      sessionId: 'session-1',
      kiloUserId: 'admin-1',
      code,
      nowIso: NOW,
      ...overrides,
    });
  }

  it('creates the protected tables with the tracked migration', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).toContain('mcp_admin_authenticators');
    expect(tables.map(t => t.name)).toContain('mcp_protected_requests');
  });

  it('exposes the request lifetime and attempt cap the OTP contract requires', () => {
    expect(PROTECTED_REQUEST_TTL_SECONDS).toBe(300);
    expect(MAX_OTP_ATTEMPTS).toBe(5);
  });

  it('creates, peeks and claims one request on the happy path', async () => {
    const secret = await enroll();
    const code = await totpCode(secret, NOW_MS);

    const request = await createRequest();
    expect(request.expiresAt).toBe('2026-09-16T12:05:00.000Z');
    expect(await store.peekProtectedRequest(request.id, 'session-1', NOW)).toEqual({
      status: 'pending',
    });

    expect(await claim(request.id, code)).toEqual({
      status: 'ok',
      path: 'organizations.admin.list',
      inputJson: '{"limit":10}',
    });
    expect(rowFor(db, 'mcp_protected_requests', 'id', request.id)).toMatchObject({
      status: 'used',
      attempts: 0,
    });
    // The accepted step is recorded so the code can never be replayed.
    expect(
      db
        .prepare('SELECT last_used_step FROM mcp_admin_authenticators WHERE kilo_user_id = ?')
        .get('admin-1')
    ).toEqual({ last_used_step: Math.floor(NOW_MS / 1000 / 30) });
    // A used request is no longer pending for anyone.
    expect(await store.peekProtectedRequest(request.id, 'session-1', NOW)).toEqual({
      status: 'gone',
    });
  });

  it('peeks gone for a foreign session and for an id that was never issued', async () => {
    const request = await createRequest();
    expect(await store.peekProtectedRequest(request.id, 'session-2', NOW)).toEqual({
      status: 'gone',
    });
    expect(await store.peekProtectedRequest('never-issued', 'session-1', NOW)).toEqual({
      status: 'gone',
    });
  });

  it('refuses a claim from another session of the same admin with the uniform refusal', async () => {
    const secret = await enroll();
    const code = await totpCode(secret, NOW_MS);
    const request = await createRequest();

    // Same admin, different connection: the request belongs to the session that
    // created it, so the correct code from another session claims nothing.
    expect(await claim(request.id, code, { sessionId: 'session-2' })).toEqual({
      status: 'not_pending',
    });
    expect(await claim('never-issued', code)).toEqual({ status: 'not_pending' });
    expect(rowFor(db, 'mcp_protected_requests', 'id', request.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  it('expires a pending request once the injected clock passes its TTL', async () => {
    const secret = await enroll();
    const request = await createRequest();
    const code = await totpCode(secret, Date.parse(AFTER_REQUEST_TTL));

    // The owning connection is told why, so the handler can serve the expired
    // refusal without reading a clock of its own.
    expect(await store.peekProtectedRequest(request.id, 'session-1', AFTER_REQUEST_TTL)).toEqual({
      status: 'expired',
    });
    // Another session — and an id that was never issued — stays uniform.
    expect(await store.peekProtectedRequest(request.id, 'session-2', AFTER_REQUEST_TTL)).toEqual({
      status: 'gone',
    });
    expect(
      await store.peekProtectedRequest('never-issued', 'session-1', AFTER_REQUEST_TTL)
    ).toEqual({ status: 'gone' });
    expect(await claim(request.id, code, { nowIso: AFTER_REQUEST_TTL })).toEqual({
      status: 'expired',
    });
    // An expired request is left pending until the alarm purge removes it.
    expect(rowFor(db, 'mcp_protected_requests', 'id', request.id)).toMatchObject({
      status: 'pending',
    });
  });

  it('refuses a code from a step that already ran a call', async () => {
    const secret = await enroll();
    const code = await totpCode(secret, NOW_MS);
    const first = await createRequest();
    expect((await claim(first.id, code)).status).toBe('ok');

    // A second call_protected in the same 30-second window: a fresh request,
    // but the same code must not run a second call.
    const second = await createRequest();
    expect(await claim(second.id, code)).toEqual({ status: 'reused_code' });
    expect(second.id).not.toBe(first.id);
    expect(rowFor(db, 'mcp_protected_requests', 'id', second.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  it('counts down the remaining attempts and invalidates the request at the cap', async () => {
    const secret = await enroll();
    const request = await createRequest();
    const correctCode = await totpCode(secret, NOW_MS);
    const wrongCode = wrongCodeFor(correctCode);

    for (let attempt = 1; attempt < MAX_OTP_ATTEMPTS; attempt++) {
      expect(await claim(request.id, wrongCode)).toEqual({
        status: 'bad_code',
        attemptsRemaining: MAX_OTP_ATTEMPTS - attempt,
      });
    }
    expect(await claim(request.id, wrongCode)).toEqual({
      status: 'bad_code',
      attemptsRemaining: 0,
    });
    expect(rowFor(db, 'mcp_protected_requests', 'id', request.id)).toMatchObject({
      status: 'invalidated',
      attempts: MAX_OTP_ATTEMPTS,
    });

    // Another session sees only the uniform refusal, never the invalidation.
    expect(await claim(request.id, correctCode, { sessionId: 'session-2' })).toEqual({
      status: 'not_pending',
    });
    expect(await store.peekProtectedRequest(request.id, 'session-2', NOW)).toEqual({
      status: 'gone',
    });
    // The owner is told the request is gone and must start a new call.
    expect(await claim(request.id, correctCode)).toEqual({ status: 'invalidated' });
    expect(await store.peekProtectedRequest(request.id, 'session-1', NOW)).toEqual({
      status: 'invalidated',
    });
  });

  it('caps wrong codes on the authenticator so a fresh request cannot reset the count', async () => {
    const secret = await enroll();
    const correctCode = await totpCode(secret, NOW_MS);
    const wrongCode = wrongCodeFor(correctCode);

    // Exhaust one request's budget: that invalidates the row, but the
    // account-wide failure count survives it — that is the point of the cap.
    const first = await createRequest();
    for (let attempt = 0; attempt < MAX_OTP_ATTEMPTS; attempt++) {
      expect((await claim(first.id, wrongCode)).status).toBe('bad_code');
    }
    expect(rowFor(db, 'mcp_protected_requests', 'id', first.id)).toMatchObject({
      status: 'invalidated',
    });
    expect(rowFor(db, 'mcp_admin_authenticators', 'kilo_user_id', 'admin-1')).toMatchObject({
      failed_attempts: MAX_OTP_ATTEMPTS,
      locked_until: null,
    });

    // call_protected mints a fresh row with attempts = 0, but the authenticator
    // keeps counting: the remaining guesses run down the account-wide budget and
    // the last one locks the gate instead of reporting another bad code.
    const second = await createRequest();
    for (let failures = MAX_OTP_ATTEMPTS + 1; failures < MAX_OTP_FAILURES; failures++) {
      expect(await claim(second.id, wrongCode)).toEqual({
        status: 'bad_code',
        attemptsRemaining: MAX_OTP_FAILURES - failures,
      });
    }
    expect(await claim(second.id, wrongCode)).toEqual({
      status: 'locked',
      retryAfterSeconds: OTP_LOCKOUT_SECONDS,
    });
    const authenticator = rowFor(db, 'mcp_admin_authenticators', 'kilo_user_id', 'admin-1');
    expect(authenticator.failed_attempts).toBe(MAX_OTP_FAILURES);
    expect(Date.parse(authenticator.locked_until as string)).toBe(
      NOW_MS + OTP_LOCKOUT_SECONDS * 1000
    );

    // While the lock holds, even a fresh request with the correct code refuses:
    // a stolen grant cannot buy a clean slate, and the caller is told the wait.
    const oneMinuteLater = '2026-09-16T12:01:00.000Z';
    const third = await createRequest();
    expect(await store.peekProtectedRequest(third.id, 'session-1', oneMinuteLater)).toEqual({
      status: 'locked',
      retryAfterSeconds: OTP_LOCKOUT_SECONDS - 60,
    });
    expect(
      await claim(third.id, await totpCode(secret, Date.parse(oneMinuteLater)), {
        nowIso: oneMinuteLater,
      })
    ).toEqual({ status: 'locked', retryAfterSeconds: OTP_LOCKOUT_SECONDS - 60 });
    expect(rowFor(db, 'mcp_protected_requests', 'id', third.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  it('starts a fresh window once the account-wide lockout expires', async () => {
    const secret = await enroll();
    const wrongCode = wrongCodeFor(await totpCode(secret, NOW_MS));
    // Fresh requests are exactly what call_protected allows, so the cap has to
    // be reached across them: the first request's own budget invalidates its
    // row, the second carries the account-wide count to the limit.
    for (const budget of [MAX_OTP_ATTEMPTS, MAX_OTP_FAILURES - MAX_OTP_ATTEMPTS]) {
      const request = await createRequest();
      for (let attempt = 0; attempt < budget; attempt++) {
        await claim(request.id, wrongCode);
      }
    }
    expect(
      Date.parse(
        rowFor(db, 'mcp_admin_authenticators', 'kilo_user_id', 'admin-1').locked_until as string
      )
    ).toBe(NOW_MS + OTP_LOCKOUT_SECONDS * 1000);

    // The lockout outlives a request's own TTL, so wait it out and start a new
    // call_protected. The expired lock is not carried over: the count restarts
    // instead of re-locking on the first mistype.
    const afterLockout = new Date(NOW_MS + (OTP_LOCKOUT_SECONDS + 1) * 1000).toISOString();
    const fresh = await store.createProtectedRequest({
      sessionId: 'session-1',
      kiloUserId: 'admin-1',
      clientId: 'client-1',
      path: 'organizations.admin.list',
      kind: 'admin',
      inputJson: null,
      nowIso: afterLockout,
    });
    expect(
      await claim(fresh.id, wrongCodeFor(await totpCode(secret, Date.parse(afterLockout))), {
        nowIso: afterLockout,
      })
    ).toEqual({
      status: 'bad_code',
      // The count restarts at 1: the tighter of the per-request and
      // per-account budgets, not the stale locked one.
      attemptsRemaining: Math.min(MAX_OTP_ATTEMPTS - 1, MAX_OTP_FAILURES - 1),
    });
    expect(rowFor(db, 'mcp_admin_authenticators', 'kilo_user_id', 'admin-1')).toMatchObject({
      failed_attempts: 1,
      locked_until: null,
    });

    // A correct code after the lock expired runs the call and clears the count.
    const approved = await store.createProtectedRequest({
      sessionId: 'session-1',
      kiloUserId: 'admin-1',
      clientId: 'client-1',
      path: 'organizations.admin.list',
      kind: 'admin',
      inputJson: null,
      nowIso: afterLockout,
    });
    expect(
      await claim(approved.id, await totpCode(secret, Date.parse(afterLockout)), {
        nowIso: afterLockout,
      })
    ).toEqual({ status: 'ok', path: 'organizations.admin.list', inputJson: null });
    expect(rowFor(db, 'mcp_admin_authenticators', 'kilo_user_id', 'admin-1')).toMatchObject({
      failed_attempts: 0,
      locked_until: null,
    });
  });

  it('answers not_pending for a used request', async () => {
    const secret = await enroll();
    const code = await totpCode(secret, NOW_MS);
    const request = await createRequest();
    expect((await claim(request.id, code)).status).toBe('ok');

    expect(await claim(request.id, wrongCodeFor(code))).toEqual({ status: 'not_pending' });
  });

  it('answers no_authenticator when the admin never enrolled', async () => {
    const request = await createRequest();
    expect(await claim(request.id, '123456')).toEqual({ status: 'no_authenticator' });
    // A failed claim without an authenticator consumes no attempt.
    expect(rowFor(db, 'mcp_protected_requests', 'id', request.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  it('treats a row that never proved possession as no authenticator at all', async () => {
    // `ensureAuthenticator` creates the row on the picker's first render, so an
    // admin can hold an unverified authenticator. The schema's invariant is
    // that `verified_at` null means unusable, and a correct code must not change
    // that: the enrollment code the picker submits is what verifies the row.
    const { secret } = await store.ensureAuthenticator('admin-1', NOW);
    const request = await createRequest();

    expect(await claim(request.id, await totpCode(secret, NOW_MS))).toEqual({
      status: 'no_authenticator',
    });
    // Refused as if no authenticator existed: no attempt is consumed.
    expect(rowFor(db, 'mcp_protected_requests', 'id', request.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  it('returns one stable secret and confirms a code from it', async () => {
    const first = await store.ensureAuthenticator('admin-1', NOW);
    expect(first.verified).toBe(false);

    // A picker re-render must never invalidate the secret already scanned.
    const second = await store.ensureAuthenticator('admin-1', '2026-09-16T12:01:00.000Z');
    expect(second).toEqual({ secret: first.secret, verified: false });

    const code = await totpCode(first.secret, NOW_MS);
    expect(await store.confirmAuthenticator('admin-1', wrongCodeFor(code), NOW)).toBe(false);
    expect(await store.confirmAuthenticator('admin-1', code, NOW)).toBe(true);
    expect(await store.confirmAuthenticator('admin-2', code, NOW)).toBe(false);
    expect((await store.ensureAuthenticator('admin-1', NOW)).verified).toBe(true);

    // The enrollment code did not consume the execution step: the same code
    // still claims the admin's first approval inside its 30-second window.
    expect(
      db
        .prepare('SELECT last_used_step FROM mcp_admin_authenticators WHERE kilo_user_id = ?')
        .get('admin-1')
    ).toEqual({ last_used_step: null });
    const request = await createRequest();
    expect(await claim(request.id, code)).toEqual({
      status: 'ok',
      path: 'organizations.admin.list',
      inputJson: '{"limit":10}',
    });
  });

  it('purges an expired request but keeps the authenticator', async () => {
    await enroll();
    const request = await createRequest();

    await store.purgeExpired(NOW);
    expect(countRows(db, 'mcp_protected_requests')).toBe(1);

    await store.purgeExpired(AFTER_REQUEST_TTL);
    expect(countRows(db, 'mcp_protected_requests')).toBe(0);
    expect(countRows(db, 'mcp_admin_authenticators')).toBe(1);
    expect(await store.peekProtectedRequest(request.id, 'session-1', AFTER_REQUEST_TTL)).toEqual({
      status: 'gone',
    });
  });

  it('serves the stored expired and cancelled refusals through the real submit_otp handler', async () => {
    // The handler reads `nowIso` from the wall clock, so the rows are made stale
    // relative to it: the expired one was created in 2020, and the cancelled one
    // is invalidated before the submit. This is the production path — the store
    // is the real Durable Object implementation, not a scripted fake.
    const handler = createMcpHandler({
      catalog: {},
      webBaseUrl: 'https://app.kilo.ai',
      protectedRequests: store,
    });
    const auth: ForwardedAuth = {
      authorization: 'Bearer kilo-token',
      kiloUserId: 'admin-1',
      clientId: 'client-1',
      adminEnabled: true,
      adminEligible: true,
      sessionId: 'session-1',
    };
    const submit = async (requestId: string): Promise<string> => {
      const response = await handler(
        new Request('https://kilo-mcp.test/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'submit_otp', arguments: { request_id: requestId, otp: '000000' } },
          }),
        }),
        auth
      );
      const json = (await response.json()) as { error: { code: number; message: string } };
      return json.error.message;
    };
    const fresh = new Date().toISOString();

    const expired = await store.createProtectedRequest({
      sessionId: 'session-1',
      kiloUserId: 'admin-1',
      clientId: 'client-1',
      path: 'organizations.admin.list',
      kind: 'admin',
      inputJson: null,
      nowIso: '2020-01-01T00:00:00.000Z',
    });
    const secret = await enroll();
    const cancelled = await store.createProtectedRequest({
      sessionId: 'session-1',
      kiloUserId: 'admin-1',
      clientId: 'client-1',
      path: 'organizations.admin.list',
      kind: 'admin',
      inputJson: null,
      nowIso: fresh,
    });
    const wrong = wrongCodeFor(await totpCode(secret, Date.now()));
    for (let attempt = 0; attempt < MAX_OTP_ATTEMPTS; attempt++) {
      expect((await claim(cancelled.id, wrong, { nowIso: fresh })).status).toBe('bad_code');
    }

    expect(await submit(expired.id)).toBe(
      'This request expired. Start a new admin or debug call with call_protected.'
    );
    expect(await submit(cancelled.id)).toBe(
      'This request was cancelled after too many incorrect codes. Start a new admin or debug call with call_protected.'
    );
  });
});
