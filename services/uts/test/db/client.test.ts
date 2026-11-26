import { inspect } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type IdentityStore,
  IdentityStoreError,
  TransactionStatementError,
  withIdentityStore,
} from '../../src/db/client';
import { lookupBotKey, lookupPat } from '../../src/db/lookups';
import {
  AccountRowSchema,
  AuditEventRowSchema,
  AuditRelayWatermarkRowSchema,
  AuthorizationCodeRowSchema,
  BrowserSessionRowSchema,
  GatePassRowSchema,
} from '../../src/db/rows';
import type { LoginRole } from './connection';
import {
  TestDatabase,
  auditEvent,
  insertAccount,
  insertBrowserSession,
  insertGatePass,
  randomHash,
} from './harness';

let db: TestDatabase;

beforeAll(async () => {
  db = await TestDatabase.create();
});
afterAll(() => db.drop());

/** Runs `work` the way a Worker does: one client per call, closed through `waitUntil`. */
async function run<Result>(login: LoginRole, work: (store: IdentityStore) => Promise<Result>) {
  const pending: Promise<unknown>[] = [];
  const result = await withIdentityStore(db.url(login), { waitUntil: p => pending.push(p) }, work);
  expect(pending).toHaveLength(1);
  await Promise.all(pending);
  return result;
}

async function failureOf(work: () => Promise<unknown>): Promise<IdentityStoreError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof IdentityStoreError) return error;
    throw error;
  }
  throw new Error('expected an identity-store failure');
}

describe('identity-store client', () => {
  it('returns no row for an unknown key', async () => {
    const row = await run('uts_app_a', store =>
      store.maybeOne(
        { text: 'SELECT * FROM uts.accounts WHERE id = $1', values: ['oauth/unknown'] },
        AccountRowSchema
      )
    );
    expect(row).toBeNull();
  });

  it('returns validated rows', async () => {
    const account = await run('uts_app_a', store =>
      store.maybeOne(
        {
          text: `INSERT INTO uts.accounts (id, primary_email) VALUES ($1, $2) RETURNING *`,
          values: ['oauth/client-test', 'client@example.com'],
        },
        AccountRowSchema
      )
    );
    expect(account).toMatchObject({ id: 'oauth/client-test', status: 'active', event_version: 0n });
  });

  it('refuses transaction control before sending anything', async () => {
    for (const text of ['BEGIN', '  start transaction', 'COMMIT', 'rollback', 'SAVEPOINT a']) {
      await expect(
        run('uts_app_a', store => store.rows({ text, values: [] }, z.unknown()))
      ).rejects.toThrow(TransactionStatementError);
    }
  });

  it('refuses a second statement in one call', async () => {
    const failure = await failureOf(() =>
      run('uts_app_a', store => store.rows({ text: 'SELECT 1; SELECT 2', values: [] }, z.unknown()))
    );
    expect(failure.failure).toBe('permanent');
    expect(failure.sqlState).toBe('42601');
  });

  it('reports a constraint failure as permanent', async () => {
    const insert = (store: IdentityStore) =>
      store.rows(
        {
          text: 'INSERT INTO uts.accounts (id, primary_email) VALUES ($1, $2)',
          values: ['oauth/duplicate', 'duplicate@example.com'],
        },
        z.unknown()
      );
    await run('uts_app_a', insert);
    const failure = await failureOf(() => run('uts_app_a', insert));
    expect(failure.failure).toBe('permanent');
    expect(failure.sqlState).toBe('23505');
    expect(failure.constraint).toBe('accounts_pkey');
    expect(failure.table).toBe('accounts');
  });

  it('keeps no row value of a refused statement in the error', async () => {
    const marker = 'failing-row-marker@example.com';
    // A blocked account without `blocked_at`: the server's detail quotes the whole row.
    const statement = {
      text: `INSERT INTO uts.accounts (id, primary_email, status) VALUES ($1, $2, 'blocked')`,
      values: ['oauth/failing-row', marker],
    };
    const raw = await db.connect('uts_app_a');
    const serverError = await raw
      .query(statement.text, statement.values)
      .catch((error: unknown) => error);
    expect(serverError).toBeInstanceOf(pg.DatabaseError);
    expect(serverError instanceof pg.DatabaseError ? serverError.detail : '').toContain(marker);

    const failure = await failureOf(() =>
      run('uts_app_a', store => store.rows(statement, z.unknown()))
    );
    expect(failure).toMatchObject({
      failure: 'permanent',
      sqlState: '23514',
      constraint: 'accounts_status_shape',
      table: 'accounts',
    });
    expect(failure.cause).toBeUndefined();
    for (const text of [inspect(failure, { depth: 10 }), JSON.stringify(failure), failure.stack]) {
      expect(text).not.toContain(marker);
      expect(text).not.toContain('oauth/failing-row');
    }
  });

  it('reports a lock timeout as retryable', async () => {
    const holder = await db.connect('uts_app_b');
    const accountId = await insertAccount(holder);
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM uts.accounts WHERE id = $1 FOR UPDATE', [accountId]);
    try {
      const failure = await failureOf(() =>
        run('uts_app_a', async store => {
          await store.rows(
            { text: `SELECT set_config('lock_timeout', '200ms', false)`, values: [] },
            z.unknown()
          );
          return store.rows(
            {
              text: `UPDATE uts.accounts SET updated_at = now() WHERE id = $1`,
              values: [accountId],
            },
            z.unknown()
          );
        })
      );
      expect(failure.failure).toBe('retryable');
      expect(failure.sqlState).toBe('55P03');
    } finally {
      await holder.query('ROLLBACK');
    }
  });

  it('reports an unreachable database as retryable, with the system error code', async () => {
    const unreachable = new URL(db.url('uts_app_a'));
    unreachable.port = '55449';
    const failure = await failureOf(() =>
      withIdentityStore(unreachable.toString(), { waitUntil: () => undefined }, async () => null)
    );
    expect(failure).toMatchObject({
      failure: 'retryable',
      sqlState: undefined,
      systemCode: 'ECONNREFUSED',
      message: 'identity store retryable failure (ECONNREFUSED)',
    });
  });

  it('decodes enum arrays, domain arrays, bytea, xid8 and int8 into the row schemas', async () => {
    const owner = await db.connectAsOwner();
    const accountId = await insertAccount(owner);
    const sessionId = await insertBrowserSession(owner, accountId);
    await insertGatePass(owner, accountId, 'pat_create');
    await owner.query(
      `INSERT INTO uts.authorization_codes
         (code_hash, client_id, client_kind, account_id, browser_session_id, redirect_uri, resources,
          scopes, code_challenge, dpop_jkt, auth_time, amr, expires_at)
       VALUES ($1, 'kilo-cli', 'first_party', $2, $3, 'http://127.0.0.1:4100/callback',
               '{gateway,kilo-chat}', '{gateway:models.read}',
               'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', $4, now(), '{oauth,passkey}',
               now() + interval '60 seconds')`,
      [randomHash(), accountId, sessionId, randomHash()]
    );
    const event = auditEvent();
    await owner.query(
      `INSERT INTO uts.audit_events (event_id, event_type, account_id, event)
       VALUES ($1, $2, $3, $4)`,
      [event.id, event.type, accountId, event]
    );

    await run('uts_app_a', async store => {
      const select = (table: string) => ({
        text: `SELECT * FROM uts.${table} WHERE account_id = $1`,
        values: [accountId],
      });
      const [code] = await store.rows(select('authorization_codes'), AuthorizationCodeRowSchema);
      expect(code.resources).toEqual(['gateway', 'kilo-chat']);
      expect(code.amr).toEqual(['oauth', 'passkey']);
      expect(code.code_hash).toHaveLength(32);
      const [session] = await store.rows(select('browser_sessions'), BrowserSessionRowSchema);
      expect(session.amr).toEqual(['oauth']);
      const [gatePass] = await store.rows(select('gate_passes'), GatePassRowSchema);
      expect(gatePass.satisfied_by).toEqual(['recent_sign_in']);
      const [audit] = await store.rows(select('audit_events'), AuditEventRowSchema);
      expect(typeof audit.txid).toBe('bigint');
      expect(audit.shard).toBe(Number(audit.id % 8n));
      expect(audit.event).toEqual(event);
      const watermarks = await store.rows(
        { text: 'SELECT * FROM uts.audit_relay_watermarks', values: [] },
        AuditRelayWatermarkRowSchema
      );
      expect(watermarks).toHaveLength(8);
    });
  });
});

describe('PAT and bot key lookups', () => {
  it('find active credentials and skip revoked, expired, blocked or cut-off ones', async () => {
    // PATs, bot keys and gate passes change only through the account functions (migration 0005),
    // so the fixtures are written as the owner.
    const writer = await db.connectAsOwner();
    const accountId = await insertAccount(writer);
    const blockedAccountId = await insertAccount(writer);
    await writer.query(
      `UPDATE uts.accounts SET status = 'blocked', blocked_at = now() WHERE id = $1`,
      [blockedAccountId]
    );
    const insertPat = async (
      status: 'active' | 'revoked',
      owner = accountId,
      createdDaysAgo = 0
    ) => {
      const tokenHash = randomHash();
      await writer.query(
        `INSERT INTO uts.personal_access_tokens
           (account_id, name, token_hash, last_four, audience, scope, gate_pass_id, created_at,
            expires_at, status, revoked_at, revoke_reason)
         VALUES ($1, 'ci', $2, 'abcd', 'gateway', 'gateway:models.read', $3,
                 now() - make_interval(days => $5),
                 now() - make_interval(days => $5) + interval '90 days',
                 $4::uts.credential_status, CASE WHEN $4::uts.credential_status = 'revoked' THEN now() END,
                 CASE WHEN $4::uts.credential_status = 'revoked' THEN 'user_revoke'::uts.revoke_reason END)`,
        [
          owner,
          tokenHash,
          await insertGatePass(writer, owner, 'pat_create'),
          status,
          createdDaysAgo,
        ]
      );
      return tokenHash;
    };
    const insertBotKey = async (status: string, flaggedDaysAgo: number | null, kept: boolean) => {
      const tokenHash = randomHash();
      await writer.query(
        `INSERT INTO uts.org_bot_keys
           (org_id, created_by, name, token_hash, last_four, audience, scope, gate_pass_id,
            created_at, expires_at, status, flagged_at, kept_by, kept_at)
         VALUES (gen_random_uuid(), $1::text, 'bot', $2, 'wxyz', 'gateway', 'gateway:models.read', $3,
                 now() - interval '20 days', now() + interval '60 days', $4::uts.bot_key_status,
                 now() - make_interval(days => $5), CASE WHEN $6 THEN $1::text END, CASE WHEN $6 THEN now() END)`,
        [
          accountId,
          tokenHash,
          await insertGatePass(writer, accountId, 'bot_key_create'),
          status,
          flaggedDaysAgo,
          kept,
        ]
      );
      return tokenHash;
    };

    const activePat = await insertPat('active');
    const revokedPat = await insertPat('revoked');
    const expiredPat = await insertPat('active', accountId, 91);
    const blockedPat = await insertPat('active', blockedAccountId);
    const activeBot = await insertBotKey('active', null, false);
    const recentlyFlagged = await insertBotKey('flagged', 2, false);
    const cutOff = await insertBotKey('flagged', 8, false);
    const kept = await insertBotKey('kept', 8, true);

    await run('uts_pat_a', async store => {
      expect(await lookupPat(store, activePat)).toMatchObject({
        account_id: accountId,
        audience: 'gateway',
        scope: 'gateway:models.read',
        org_id: null,
      });
      expect(await lookupPat(store, revokedPat)).toBeNull();
      expect(await lookupPat(store, expiredPat)).toBeNull();
      expect(await lookupPat(store, blockedPat)).toBeNull();
      expect(await lookupPat(store, randomHash())).toBeNull();

      expect(await lookupBotKey(store, activeBot)).toMatchObject({ status: 'active' });
      const flagged = await lookupBotKey(store, recentlyFlagged);
      expect(flagged?.status).toBe('flagged');
      expect(flagged?.valid_until.getTime()).toBeLessThan(Date.now() + 6 * 86_400_000);
      expect(await lookupBotKey(store, cutOff)).toBeNull();
      expect(await lookupBotKey(store, kept)).toMatchObject({ status: 'kept' });
    });
  });

  it('rejects a hash that is not 32 bytes before querying', async () => {
    await expect(
      run('uts_pat_a', store => lookupPat(store, randomHash().subarray(0, 31)))
    ).rejects.toThrow(z.ZodError);
  });
});
