import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  TestDatabase,
  insertAccount,
  insertDeviceSession,
  randomHash,
  sqlStateOf,
} from './harness';

/**
 * `uts.write_gated_pat` and `uts.write_gated_bot_key` decide the tier B gate inside the statement
 * that writes the credential, write the pass already consumed and write the credential that names
 * it (design section 5.11). No login role may call them; the SECURITY DEFINER statements of the
 * account API do, so these tests call them as the owner.
 */

let db: TestDatabase;
let owner: pg.Client;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
});
afterAll(() => db.drop());

type PatWrite = {
  outcome: string;
  new_pat_id: string | null;
  new_gate_pass_id: string | null;
  gate_checks: string | null;
};

async function writePat(
  accountId: string,
  deviceSessionId: string,
  options: { orgId?: string; lifetimeDays?: number } = {}
): Promise<PatWrite> {
  const result = await owner.query<PatWrite>(
    `SELECT outcome, new_pat_id, new_gate_pass_id, gate_checks::text
     FROM uts.write_gated_pat($1, $2, 'ci', $3, 'abcd', 'gateway:models.read', $4, $5)`,
    [accountId, deviceSessionId, randomHash(), options.orgId ?? null, options.lifetimeDays ?? 90]
  );
  return result.rows[0];
}

async function writeBotKey(accountId: string, deviceSessionId: string, orgId: string) {
  const result = await owner.query<PatWrite & { new_key_id: string | null }>(
    `SELECT outcome, new_key_id, new_gate_pass_id, gate_checks::text
     FROM uts.write_gated_bot_key($1, $2, $3, 'bot', $4, 'wxyz', 'gateway:models.read', 90)`,
    [accountId, deviceSessionId, orgId, randomHash()]
  );
  return result.rows[0];
}

/** A device session that signed in `minutesAgo` minutes ago. */
async function sessionSignedIn(accountId: string, minutesAgo: number): Promise<string> {
  const sessionId = await insertDeviceSession(owner, accountId);
  await owner.query(
    `UPDATE uts.device_sessions SET auth_time = now() - make_interval(mins => $2) WHERE id = $1`,
    [sessionId, minutesAgo]
  );
  return sessionId;
}

async function joinOrg(accountId: string, role: string): Promise<string> {
  const orgId = randomUUID();
  await owner.query(
    `INSERT INTO uts.org_memberships (org_id, account_id, role, event_version) VALUES ($1, $2, $3, 1)`,
    [orgId, accountId, role]
  );
  return orgId;
}

/** The pass, and whether it was consumed in the transaction that wrote its credential. */
async function passOf(gatePassId: string) {
  const result = await owner.query(
    `SELECT pass.tier, pass.action, pass.status, pass.satisfied_by::text,
       pass.consumed_at IN (
         SELECT created_at FROM uts.personal_access_tokens WHERE gate_pass_id = pass.id
         UNION ALL
         SELECT created_at FROM uts.org_bot_keys WHERE gate_pass_id = pass.id
       ) AS consumed_with_credential
     FROM uts.gate_passes AS pass WHERE pass.id = $1`,
    [gatePassId]
  );
  return result.rows[0];
}

describe('uts.write_gated_pat', () => {
  it('write the PAT with its own pass, consumed in the same statement', async () => {
    const accountId = await insertAccount(owner);
    const sessionId = await sessionSignedIn(accountId, 1);

    const first = await writePat(accountId, sessionId);
    const second = await writePat(accountId, sessionId);

    expect(first).toMatchObject({ outcome: 'created', gate_checks: '{recent_sign_in}' });
    expect(second.outcome).toBe('created');
    expect(first.new_gate_pass_id).not.toBe(second.new_gate_pass_id);
    for (const write of [first, second]) {
      expect(await passOf(write.new_gate_pass_id ?? '')).toEqual({
        tier: 'b',
        action: 'pat_create',
        status: 'consumed',
        satisfied_by: '{recent_sign_in}',
        consumed_with_credential: true,
      });
      const pat = await owner.query(
        'SELECT gate_pass_id, audience, account_id FROM uts.personal_access_tokens WHERE id = $1',
        [write.new_pat_id]
      );
      expect(pat.rows).toEqual([
        { gate_pass_id: write.new_gate_pass_id, audience: 'gateway', account_id: accountId },
      ]);
    }
  });

  it('refuse a session without a sign-in or passkey step-up in the last 10 minutes, writing nothing', async () => {
    const accountId = await insertAccount(owner);
    const sessionId = await sessionSignedIn(accountId, 11);
    expect(await writePat(accountId, sessionId)).toEqual({
      outcome: 'gate_required',
      new_pat_id: null,
      new_gate_pass_id: null,
      gate_checks: '{}',
    });
    const written = await owner.query(
      `SELECT (SELECT count(*) FROM uts.gate_passes WHERE account_id = $1)::int AS passes,
              (SELECT count(*) FROM uts.personal_access_tokens WHERE account_id = $1)::int AS pats`,
      [accountId]
    );
    expect(written.rows).toEqual([{ passes: 0, pats: 0 }]);
  });

  it('accept a passkey step-up of the same session in place of a recent sign-in', async () => {
    const accountId = await insertAccount(owner);
    const sessionId = await sessionSignedIn(accountId, 30);
    const otherSessionId = await sessionSignedIn(accountId, 30);
    const passkey = await owner.query<{ id: string }>(
      `INSERT INTO uts.passkey_credentials
         (account_id, credential_id, public_key, backup_eligible, backed_up, rp_id, name)
       VALUES ($1, $2, '\\x01', true, true, 'app.example.com', 'laptop') RETURNING id`,
      [accountId, randomHash()]
    );
    await owner.query(
      `INSERT INTO uts.step_ups (account_id, device_session_id, purpose, passkey_credential_id, expires_at)
       VALUES ($1, $2, 'gate', $3, now() + interval '10 minutes')`,
      [accountId, sessionId, passkey.rows[0].id]
    );
    expect(await writePat(accountId, sessionId)).toMatchObject({
      outcome: 'created',
      gate_checks: '{passkey}',
    });
    // The step-up belongs to its own session only.
    expect((await writePat(accountId, otherSessionId)).outcome).toBe('gate_required');
  });

  it('refuse a session of another account, or a revoked one', async () => {
    const accountId = await insertAccount(owner);
    const otherAccountId = await insertAccount(owner);
    expect((await writePat(accountId, await sessionSignedIn(otherAccountId, 1))).outcome).toBe(
      'invalid_session'
    );
    const revoked = await sessionSignedIn(accountId, 1);
    await owner.query(
      `UPDATE uts.device_sessions SET status = 'revoked', revoked_at = now(),
         revoke_reason = 'sign_out'
       WHERE id = $1`,
      [revoked]
    );
    expect((await writePat(accountId, revoked)).outcome).toBe('invalid_session');
  });

  it('bind a PAT to an organization only for an active member', async () => {
    const accountId = await insertAccount(owner);
    const sessionId = await sessionSignedIn(accountId, 1);
    expect((await writePat(accountId, sessionId, { orgId: randomUUID() })).outcome).toBe(
      'org_denied'
    );
    const orgId = await joinOrg(accountId, 'member');
    expect((await writePat(accountId, sessionId, { orgId })).outcome).toBe('created');
    await owner.query(
      `UPDATE uts.org_memberships SET status = 'removed', removed_at = now(), event_version = 2
       WHERE org_id = $1 AND account_id = $2`,
      [orgId, accountId]
    );
    expect((await writePat(accountId, sessionId, { orgId })).outcome).toBe('org_denied');
  });

  it('stop at 100 live PATs per account', async () => {
    const accountId = await insertAccount(owner);
    const sessionId = await sessionSignedIn(accountId, 1);
    await owner.query(
      `WITH passes AS (
         INSERT INTO uts.gate_passes
           (account_id, device_session_id, tier, action, satisfied_by, expires_at, status, consumed_at)
         SELECT $1, $2, 'b', 'pat_create', '{recent_sign_in}', now() + interval '10 minutes',
                'consumed', now()
         FROM generate_series(1, 99)
         RETURNING id
       )
       INSERT INTO uts.personal_access_tokens
         (account_id, name, token_hash, last_four, audience, scope, gate_pass_id, created_at,
          expires_at)
       SELECT $1, 'seed', sha256(convert_to(id::text, 'UTF8')), 'abcd', 'gateway',
              'gateway:models.read', id, now() - interval '2 hours', now() + interval '90 days'
       FROM passes`,
      [accountId, sessionId]
    );
    expect((await writePat(accountId, sessionId)).outcome).toBe('created');
    expect(await writePat(accountId, sessionId)).toMatchObject({
      outcome: 'limit_reached',
      new_gate_pass_id: null,
    });
  });

  it('refuse a lifetime outside 1 to 365 days', async () => {
    const accountId = await insertAccount(owner);
    const sessionId = await sessionSignedIn(accountId, 1);
    expect(await sqlStateOf(() => writePat(accountId, sessionId, { lifetimeDays: 0 }))).toBe(
      '22023'
    );
    expect(await sqlStateOf(() => writePat(accountId, sessionId, { lifetimeDays: 366 }))).toBe(
      '22023'
    );
  });
});

describe('uts.write_gated_bot_key', () => {
  it('let an owner or admin create a key with its own consumed pass, and refuse a member', async () => {
    const adminId = await insertAccount(owner);
    const orgId = await joinOrg(adminId, 'admin');
    const write = await writeBotKey(adminId, await sessionSignedIn(adminId, 1), orgId);
    expect(write).toMatchObject({ outcome: 'created', gate_checks: '{recent_sign_in}' });
    expect(await passOf(write.new_gate_pass_id ?? '')).toMatchObject({
      action: 'bot_key_create',
      status: 'consumed',
      consumed_with_credential: true,
    });

    const memberId = await insertAccount(owner);
    await owner.query(
      `INSERT INTO uts.org_memberships (org_id, account_id, role, event_version)
       VALUES ($1, $2, 'member', 1)`,
      [orgId, memberId]
    );
    expect((await writeBotKey(memberId, await sessionSignedIn(memberId, 1), orgId)).outcome).toBe(
      'not_org_admin'
    );
  });

  it('refuse a stale session, writing nothing', async () => {
    const adminId = await insertAccount(owner);
    const orgId = await joinOrg(adminId, 'owner');
    expect((await writeBotKey(adminId, await sessionSignedIn(adminId, 11), orgId)).outcome).toBe(
      'gate_required'
    );
    const keys = await owner.query('SELECT 1 FROM uts.org_bot_keys WHERE org_id = $1', [orgId]);
    expect(keys.rowCount).toBe(0);
  });

  it('make an account deletion wait on the account row, then flag the new key', async () => {
    const adminId = await insertAccount(owner);
    const orgId = await joinOrg(adminId, 'admin');
    const sessionId = await sessionSignedIn(adminId, 1);
    const creator = await db.connectAsOwner();
    const deleter = await db.connectAsOwner();
    const deleterPid = (await deleter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0].pid;
    await creator.query('BEGIN');
    const key = await creator.query<{ new_key_id: string }>(
      `SELECT new_key_id
       FROM uts.write_gated_bot_key($1, $2, $3, 'bot', $4, 'wxyz', 'gateway:models.read', 90)`,
      [adminId, sessionId, orgId, randomHash()]
    );
    const deleted = deleter.query('DELETE FROM uts.accounts WHERE id = $1', [adminId]);
    // Both take the account row first, so the deletion queues there (a tuple lock on the account
    // table) rather than on the membership row in its cascade, where it could deadlock.
    await vi.waitFor(
      async () => {
        const locks = await owner.query<{ relation: string }>(
          `SELECT relation::regclass::text AS relation FROM pg_locks
           WHERE pid = $1 AND locktype = 'tuple'`,
          [deleterPid]
        );
        expect(locks.rows).toEqual([{ relation: 'uts.accounts' }]);
      },
      { timeout: 5_000, interval: 20 }
    );
    await creator.query('COMMIT');
    await deleted;
    const flagged = await owner.query(
      'SELECT status::text, gate_pass_id FROM uts.org_bot_keys WHERE id = $1',
      [key.rows[0].new_key_id]
    );
    expect(flagged.rows).toEqual([{ status: 'flagged', gate_pass_id: null }]);
  });
});

describe('a member removal that races a create', () => {
  /**
   * A stand-in for the removal statement a later pull request adds: it updates the membership row
   * in its first statement and revokes and flags in later ones, so each later statement takes a
   * fresh snapshot after the wait on the create's membership lock.
   */
  const REMOVE_IN_STEPS = `
    CREATE FUNCTION uts.test_remove_member(p_org_id uuid, p_account_id text) RETURNS void
    LANGUAGE plpgsql VOLATILE
    SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      UPDATE uts.org_memberships
      SET status = 'removed', removed_at = now(), event_version = event_version + 1
      WHERE org_id = p_org_id AND account_id = p_account_id AND status = 'active';
      UPDATE uts.personal_access_tokens
      SET status = 'revoked', revoked_at = now(), revoke_reason = 'member_removed'
      WHERE account_id = p_account_id AND org_id = p_org_id AND status = 'active';
      UPDATE uts.org_bot_keys SET status = 'flagged', flagged_at = now()
      WHERE org_id = p_org_id AND created_by = p_account_id AND status = 'active';
    END
    $$`;
  /** The same removal as one statement: every part shares the snapshot taken before the wait. */
  const REMOVE_IN_ONE_STATEMENT = `
    WITH removed AS (
      UPDATE uts.org_memberships
      SET status = 'removed', removed_at = now(), event_version = event_version + 1
      WHERE org_id = $1 AND account_id = $2 AND status = 'active'
      RETURNING org_id, account_id
    ), pats AS (
      UPDATE uts.personal_access_tokens AS pat
      SET status = 'revoked', revoked_at = now(), revoke_reason = 'member_removed'
      FROM removed
      WHERE pat.account_id = removed.account_id AND pat.org_id = removed.org_id
        AND pat.status = 'active'
      RETURNING pat.id
    ), keys AS (
      UPDATE uts.org_bot_keys AS bot_key SET status = 'flagged', flagged_at = now()
      FROM removed
      WHERE bot_key.org_id = removed.org_id AND bot_key.created_by = removed.account_id
        AND bot_key.status = 'active'
      RETURNING bot_key.id
    )
    SELECT (SELECT count(*) FROM pats) AS pats, (SELECT count(*) FROM keys) AS keys`;

  beforeAll(async () => {
    await owner.query(REMOVE_IN_STEPS);
  });

  /**
   * Creates an org PAT and a bot key in one open transaction, starts `removal` while the
   * create's membership lock is held, commits the create once the removal waits on that lock,
   * and returns the final status of both credentials.
   */
  async function race(
    removal: (remover: pg.Client, orgId: string, accountId: string) => Promise<unknown>
  ) {
    const adminId = await insertAccount(owner);
    const orgId = await joinOrg(adminId, 'admin');
    const sessionId = await sessionSignedIn(adminId, 1);
    const creator = await db.connectAsOwner();
    const remover = await db.connectAsOwner();
    const removerPid = (await remover.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0].pid;

    await creator.query('BEGIN');
    const key = await creator.query<{ outcome: string; new_key_id: string }>(
      `SELECT outcome, new_key_id
       FROM uts.write_gated_bot_key($1, $2, $3, 'bot', $4, 'wxyz', 'gateway:models.read', 90)`,
      [adminId, sessionId, orgId, randomHash()]
    );
    const pat = await creator.query<{ outcome: string; new_pat_id: string }>(
      `SELECT outcome, new_pat_id
       FROM uts.write_gated_pat($1, $2, 'ci', $3, 'abcd', 'gateway:models.read', $4, 90)`,
      [adminId, sessionId, randomHash(), orgId]
    );
    expect([key.rows[0].outcome, pat.rows[0].outcome]).toEqual(['created', 'created']);

    const removed = removal(remover, orgId, adminId);
    await vi.waitFor(
      async () => {
        const waiting = await owner.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [
          removerPid,
        ]);
        expect(waiting.rowCount).toBe(1);
      },
      { timeout: 5_000, interval: 20 }
    );
    await creator.query('COMMIT');
    await removed;

    const statuses = await owner.query<{ key: string; pat: string }>(
      `SELECT (SELECT status::text FROM uts.org_bot_keys WHERE id = $1) AS key,
              (SELECT status::text FROM uts.personal_access_tokens WHERE id = $2) AS pat`,
      [key.rows[0].new_key_id, pat.rows[0].new_pat_id]
    );
    return statuses.rows[0];
  }

  it('flag the new key and revoke the new org PAT when the removal revokes in later statements', async () => {
    const statuses = await race((remover, orgId, accountId) =>
      remover.query('SELECT uts.test_remove_member($1, $2)', [orgId, accountId])
    );
    expect(statuses).toEqual({ key: 'flagged', pat: 'revoked' });
  });

  it('miss both when the removal is one statement, which is why the removal must not be one', async () => {
    const statuses = await race((remover, orgId, accountId) =>
      remover.query(REMOVE_IN_ONE_STATEMENT, [orgId, accountId])
    );
    expect(statuses).toEqual({ key: 'active', pat: 'active' });
  });
});
