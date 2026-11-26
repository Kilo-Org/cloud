import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AuditEventSchema } from '@kilocode/sts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type AccountStore, identityStoreAccount } from '../../src/account/store';
import { IdentityStore } from '../../src/db/client';
import { lookupBotKey, lookupPat } from '../../src/db/lookups';
import { createSecret, hexOfHash, lastFour } from '../../src/pat/format';
import { TestDatabase, insertAccount, sqlStateOf } from './harness';

/**
 * The account functions (migration 0005) through the Worker's own statements
 * (`src/account/store.ts`), run as the app login. Fixtures that sign-in, passkey and membership
 * slices write (accounts, sessions, grants, step-ups, memberships, email codes) are inserted as the
 * owner.
 */

let db: TestDatabase;
let owner: pg.Client;
let app: pg.Client;
let patLogin: pg.Client;
let account: AccountStore;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  app = await db.connect('uts_app_a');
  patLogin = await db.connect('uts_pat_a');
  account = identityStoreAccount(new IdentityStore(app));
});
afterAll(() => db.drop());

const environment = 'development';
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const reference = (hash: Buffer) => hash.toString('base64url').slice(0, 8);

/** A second app connection's statement store, for the tests that run two statements at once. */
async function secondConnection() {
  const client = await db.connect('uts_app_b');
  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  return { client, pid, account: identityStoreAccount(new IdentityStore(client)) };
}

/**
 * Waits until the session `pid` waits for a lock, so the test knows the statement it started
 * there is blocked rather than finished or not yet sent. `pg_locks` is readable by every role.
 */
async function waitUntilBlocked(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await owner.query<{ waiting: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted) AS waiting',
      [pid]
    );
    if (result.rows[0].waiting) return;
    await sleep(20);
  }
  throw new Error(`session ${pid} never waited for a lock`);
}

type Session = { accountId: string; grantId: string; deviceSessionId: string };

/** A first-party grant whose device session signed in `minutesAgo` minutes ago with `amr`. */
async function session(
  options: { minutesAgo?: number; amr?: string[]; accountId?: string } = {}
): Promise<Session> {
  const accountId = options.accountId ?? (await insertAccount(owner));
  const device = await owner.query<{ id: string }>(
    `INSERT INTO uts.device_sessions (account_id, client_class, device_label, platform, auth_time, amr)
     VALUES ($1, 'desktop', 'test device', 'linux', now() - make_interval(mins => $2), $3)
     RETURNING id`,
    [accountId, options.minutesAgo ?? 1, options.amr ?? ['passkey']]
  );
  const grant = await owner.query<{ id: string }>(
    `INSERT INTO uts.refresh_grants (account_id, device_session_id, client_id, client_class,
       token_hash, dpop_jkt, allowed_scopes, idle_expires_at, expires_at)
     VALUES ($1, $2, 'kilo-cli', 'desktop', $3, $4, '{uts:pats.manage}', now() + interval '30 days',
       now() + interval '180 days')
     RETURNING id`,
    [accountId, device.rows[0].id, randomBytes(32), randomBytes(32)]
  );
  return { accountId, grantId: grant.rows[0].id, deviceSessionId: device.rows[0].id };
}

async function membership(orgId: string, accountId: string, role: string, enforcement?: string) {
  await owner.query(
    `INSERT INTO uts.org_memberships (org_id, account_id, role, event_version) VALUES ($1, $2, $3, 1)`,
    [orgId, accountId, role]
  );
  if (enforcement !== undefined) {
    await owner.query(
      `INSERT INTO uts.org_sso_policies (org_id, enforcement, event_version) VALUES ($1, $2, 1)
       ON CONFLICT (org_id) DO NOTHING`,
      [orgId, enforcement]
    );
  }
}

function patInput(
  holder: Session,
  overrides: Partial<Parameters<AccountStore['createPat']>[0]> = {}
) {
  const token = createSecret('pat');
  return {
    token,
    input: {
      environment,
      accountId: holder.accountId,
      grantId: holder.grantId,
      name: 'ci deploy',
      tokenHash: sha256(token),
      lastFour: lastFour(token),
      scope: 'uts:probe.read',
      orgId: null,
      lifetimeDays: 90,
      ...overrides,
    } as const,
  };
}

async function createdPat(holder: Session, overrides: Parameters<typeof patInput>[1] = {}) {
  const { token, input } = patInput(holder, overrides);
  const result = await account.createPat(input);
  if (result.outcome !== 'created') throw new Error(`expected created, got ${result.outcome}`);
  return { token, id: result.id, result };
}

/** `count` PATs of `holder`, live for a day, or created 2 days ago and expired a day ago. */
async function insertPats(holder: Session, count: number, state: 'live' | 'expired') {
  await owner.query(
    `WITH passes AS (
       INSERT INTO uts.gate_passes (account_id, device_session_id, tier, action, satisfied_by,
         expires_at, status, consumed_at)
       SELECT $1, $2, 'b', 'pat_create', '{recent_sign_in}', now() + interval '10 minutes',
         'consumed', now()
       FROM generate_series(1, $3::integer)
       RETURNING id
     )
     INSERT INTO uts.personal_access_tokens (account_id, name, token_hash, last_four, audience,
       scope, gate_pass_id, created_at, expires_at)
     SELECT $1, 'bulk', sha256(convert_to(id::text, 'UTF8')), 'abcd', 'uts', 'uts:probe.read', id,
       now() - CASE WHEN $4::boolean THEN interval '0' ELSE interval '2 days' END,
       now() + CASE WHEN $4::boolean THEN interval '1 day' ELSE interval '-1 day' END
     FROM passes`,
    [holder.accountId, holder.deviceSessionId, count, state === 'live']
  );
}

const AuditRowSchema = z.object({ event_type: z.string(), event: z.unknown() });

async function auditRows(accountId: string) {
  const result = await owner.query(
    'SELECT event_type, event FROM uts.audit_events WHERE account_id = $1 ORDER BY id',
    [accountId]
  );
  return result.rows.map(row => {
    const parsed = AuditRowSchema.parse(row);
    return { type: parsed.event_type, event: AuditEventSchema.parse(parsed.event) };
  });
}

async function eventsText(): Promise<string> {
  const result = await owner.query<{ text: string }>(
    `SELECT coalesce(string_agg(event::text, ' '), '') AS text FROM uts.audit_events`
  );
  return result.rows[0].text;
}

describe('PAT create', () => {
  it('creates a PAT after a recent sign-in, with its consumed pass, notice and audit row', async () => {
    const holder = await session();
    const { token, id, result } = await createdPat(holder);
    expect(result.expiresAt.getTime() - result.createdAt.getTime()).toBe(90 * 86_400_000);

    const stored = await owner.query(
      `SELECT pat.token_hash, pat.last_four, pat.audience, pat.scope, pass.tier, pass.action,
              pass.status, pass.satisfied_by::text[] AS satisfied_by, pass.device_session_id
       FROM uts.personal_access_tokens AS pat JOIN uts.gate_passes AS pass ON pass.id = pat.gate_pass_id
       WHERE pat.id = $1`,
      [id]
    );
    expect(stored.rows).toEqual([
      {
        token_hash: sha256(token),
        last_four: token.slice(-4),
        audience: 'uts',
        scope: 'uts:probe.read',
        tier: 'b',
        action: 'pat_create',
        status: 'consumed',
        satisfied_by: ['recent_sign_in'],
        device_session_id: holder.deviceSessionId,
      },
    ]);
    const notices = await owner.query(
      `SELECT notice.kind, notice.details, audit.event_type
       FROM uts.notices AS notice JOIN uts.audit_events AS audit ON audit.event_id = notice.audit_event_id
       WHERE notice.account_id = $1`,
      [holder.accountId]
    );
    expect(notices.rows).toEqual([
      {
        kind: 'credential_created',
        details: { credential: 'pat', patId: id, scope: 'uts:probe.read' },
        event_type: 'ai.kilo.uts.pat.created',
      },
    ]);
    const [audit] = await auditRows(holder.accountId);
    expect(audit.event.data).toMatchObject({
      classUid: 6003,
      activityId: 1,
      outcome: 'success',
      actor: { kind: 'user', id: holder.accountId },
      attributes: {
        patId: id,
        patRef: reference(sha256(token)),
        audience: 'uts',
        scope: 'uts:probe.read',
        lifetimeDays: 90,
        grantId: holder.grantId,
        gateChecks: ['recent_sign_in'],
      },
    });

    const text = await eventsText();
    expect(text).not.toContain(token);
    expect(text).not.toContain(hexOfHash(sha256(token)));
    expect(text).not.toContain(sha256(token).toString('base64url'));
    expect(text).not.toContain('ci deploy');
  });

  it('creates a PAT for the Kilo API profile scope under the kilo-api audience', async () => {
    const holder = await session();
    const { token } = await createdPat(holder, { scope: 'kilo-api:profile.read' });
    expect(await lookupPat(new IdentityStore(patLogin), sha256(token))).toMatchObject({
      audience: 'kilo-api',
      scope: 'kilo-api:profile.read',
    });
  });

  it('is found by its hash through the PAT login', async () => {
    const holder = await session();
    const { token, id } = await createdPat(holder);
    expect(await lookupPat(new IdentityStore(patLogin), sha256(token))).toMatchObject({
      pat_id: id,
      account_id: holder.accountId,
      audience: 'uts',
      scope: 'uts:probe.read',
    });
  });

  it('passes with a passkey step-up of the same session when the sign-in is older', async () => {
    const holder = await session({ minutesAgo: 60 });
    const passkey = await owner.query<{ id: string }>(
      `INSERT INTO uts.passkey_credentials (account_id, credential_id, public_key, backup_eligible,
         backed_up, rp_id, name, added_at)
       VALUES ($1, $2, $3, false, false, 'app.kilo.ai', 'laptop', now() - interval '30 days')
       RETURNING id`,
      [holder.accountId, randomBytes(32), randomBytes(32)]
    );
    await owner.query(
      `INSERT INTO uts.step_ups (account_id, device_session_id, purpose, passkey_credential_id, expires_at)
       VALUES ($1, $2, 'gate', $3, now() + interval '10 minutes')`,
      [holder.accountId, holder.deviceSessionId, passkey.rows[0].id]
    );
    const { id } = await createdPat(holder);
    const pass = await owner.query(
      `SELECT pass.satisfied_by::text[] AS satisfied_by FROM uts.gate_passes AS pass
       JOIN uts.personal_access_tokens AS pat ON pat.gate_pass_id = pass.id WHERE pat.id = $1`,
      [id]
    );
    expect(pass.rows).toEqual([{ satisfied_by: ['passkey'] }]);
  });

  it('refuses without a sign-in or step-up in 10 minutes, with one denied row per minute', async () => {
    const holder = await session({ minutesAgo: 11 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await account.createPat(patInput(holder).input)).outcome).toBe('gate_required');
    }
    const pats = await owner.query(
      'SELECT 1 FROM uts.personal_access_tokens WHERE account_id = $1',
      [holder.accountId]
    );
    expect(pats.rowCount).toBe(0);
    const rows = await auditRows(holder.accountId);
    expect(rows.map(row => row.type)).toEqual(['ai.kilo.uts.gate.refused']);
    expect(rows[0].event.data).toMatchObject({
      classUid: 3001,
      outcome: 'denied',
      outcomeDetail: 'fresh sign-in required',
      attributes: { action: 'pat_create', tier: 'b', grantId: holder.grantId },
    });
  });

  it('refuses a revoked grant, another account, and a blocked account', async () => {
    const holder = await session();
    const other = await session();
    expect(
      (await account.createPat(patInput({ ...holder, grantId: other.grantId }).input)).outcome
    ).toBe('invalid_session');
    await owner.query(
      `UPDATE uts.refresh_grants SET status = 'revoked', revoked_at = now(), revoke_reason = 'sign_out'
       WHERE id = $1`,
      [other.grantId]
    );
    expect((await account.createPat(patInput(other).input)).outcome).toBe('invalid_session');
    await owner.query(
      `UPDATE uts.accounts SET status = 'blocked', blocked_at = now() WHERE id = $1`,
      [holder.accountId]
    );
    expect((await account.createPat(patInput(holder).input)).outcome).toBe('invalid_session');
  });

  it('binds a PAT to an organization only for an active member that meets its SSO rule', async () => {
    const holder = await session();
    const orgId = randomUUID();
    expect((await account.createPat(patInput(holder, { orgId }).input)).outcome).toBe('org_denied');
    await membership(orgId, holder.accountId, 'member');
    const { id } = await createdPat(holder, { orgId });
    const row = await owner.query('SELECT org_id FROM uts.personal_access_tokens WHERE id = $1', [
      id,
    ]);
    expect(row.rows).toEqual([{ org_id: orgId }]);

    const ssoOrg = randomUUID();
    await membership(ssoOrg, holder.accountId, 'member', 'required');
    expect((await account.createPat(patInput(holder, { orgId: ssoOrg }).input)).outcome).toBe(
      'org_denied'
    );
    const ssoHolder = await session({ accountId: holder.accountId, amr: ['sso'] });
    expect((await account.createPat(patInput(ssoHolder, { orgId: ssoOrg }).input)).outcome).toBe(
      'created'
    );
  });

  it('keeps an account at 100 live PATs; revoked and expired ones do not count', async () => {
    const holder = await session();
    await insertPats(holder, 100, 'live');
    await insertPats(holder, 1, 'expired');
    expect((await account.createPat(patInput(holder).input)).outcome).toBe('limit_reached');
    await owner.query(
      `UPDATE uts.personal_access_tokens SET status = 'revoked', revoked_at = now(),
         revoke_reason = 'user_revoke'
       WHERE id = (SELECT id FROM uts.personal_access_tokens WHERE account_id = $1 LIMIT 1)`,
      [holder.accountId]
    );
    expect((await account.createPat(patInput(holder).input)).outcome).toBe('created');
  });

  it('puts two concurrent creates in order, so the 100th and 101st cannot both pass', async () => {
    const holder = await session();
    await insertPats(holder, 99, 'live');
    const first = await db.connect('uts_app_a');
    const second = await secondConnection();
    await first.query('BEGIN');
    try {
      const created = await identityStoreAccount(new IdentityStore(first)).createPat(
        patInput(holder).input
      );
      expect(created.outcome).toBe('created');
      const racing = second.account.createPat(patInput(holder).input);
      await waitUntilBlocked(second.pid);
      await first.query('COMMIT');
      expect((await racing).outcome).toBe('limit_reached');
    } finally {
      await first.query('ROLLBACK');
    }
  });

  it('allows 1 to 365 days and refuses any other lifetime', async () => {
    const holder = await session();
    const { result } = await createdPat(holder, { lifetimeDays: 365 });
    expect(result.expiresAt.getTime() - result.createdAt.getTime()).toBe(365 * 86_400_000);
    for (const lifetimeDays of [0, 366]) {
      await expect(
        account.createPat(patInput(holder, { lifetimeDays }).input)
      ).rejects.toMatchObject({ failure: 'permanent', sqlState: '22023' });
    }
  });
});

describe('PAT list and revoke', () => {
  it('lists live PATs newest first, and an empty list for an account without one', async () => {
    const holder = await session();
    expect(await account.listPats(holder)).toEqual({ outcome: 'listed', pats: [] });
    const first = await createdPat(holder, { name: 'first' });
    const second = await createdPat(holder, { name: 'second' });
    await account.revokePat({ environment, ...holder, patId: first.id });
    const listed = await account.listPats(holder);
    expect(listed).toEqual({
      outcome: 'listed',
      pats: [
        {
          id: second.id,
          name: 'second',
          audience: 'uts',
          scope: 'uts:probe.read',
          org: null,
          last_four: second.token.slice(-4),
          created_at: second.result.createdAt.toISOString(),
          expires_at: second.result.expiresAt.toISOString(),
          last_used_at: null,
        },
      ],
    });
    expect(await account.listPats({ ...holder, grantId: randomUUID() })).toEqual({
      outcome: 'invalid_session',
    });
  });

  it('revokes once, with a 15-minute feed entry returned and stored, an audit row, and the lookup stops', async () => {
    const holder = await session();
    const { token, id } = await createdPat(holder);
    const revoked = await account.revokePat({ environment, ...holder, patId: id });
    expect(revoked).toEqual({
      outcome: 'revoked',
      feedEntries: [expect.objectContaining({ kind: 'pat', id, revokedBefore: null })],
    });
    const [entry] = revoked.feedEntries;
    expect(entry.expiresAt - entry.revokedAt).toBe(15 * 60_000);
    expect(await account.revokePat({ environment, ...holder, patId: id })).toEqual({
      outcome: 'already_revoked',
      feedEntries: [],
    });
    expect(await lookupPat(new IdentityStore(patLogin), sha256(token))).toBeNull();
    const feed = await owner.query(
      `SELECT kind, feed_expires_at - revoked_at AS ttl FROM uts.revocations WHERE subject_id = $1`,
      [id]
    );
    expect(feed.rows).toEqual([{ kind: 'pat', ttl: expect.objectContaining({ minutes: 15 }) }]);
    const rows = await auditRows(holder.accountId);
    expect(rows.at(-1)).toMatchObject({
      type: 'ai.kilo.uts.pat.revoked',
      event: {
        data: {
          activityId: 4,
          attributes: { patId: id, patRef: reference(sha256(token)), reason: 'user_revoke' },
        },
      },
    });
    expect(await eventsText()).not.toContain(token);
  });

  it('finds no PAT of another account, and refuses a caller whose session ended', async () => {
    const holder = await session();
    const other = await session();
    const { id } = await createdPat(holder);
    expect(await account.revokePat({ environment, ...other, patId: id })).toEqual({
      outcome: 'not_found',
      feedEntries: [],
    });
    expect(
      await account.revokePat({ environment, ...holder, grantId: other.grantId, patId: id })
    ).toEqual({ outcome: 'invalid_session', feedEntries: [] });
  });
});

/** An organization with an admin session (signed in a minute ago) and a member session. */
async function organization() {
  const orgId = randomUUID();
  const admin = await session();
  const member = await session();
  await membership(orgId, admin.accountId, 'admin');
  await membership(orgId, member.accountId, 'member');
  return { orgId, admin, member };
}

function botKeyInput(holder: Session, orgId: string) {
  const token = createSecret('bot_key');
  return {
    token,
    input: {
      environment,
      accountId: holder.accountId,
      grantId: holder.grantId,
      orgId,
      name: 'deploy bot',
      tokenHash: sha256(token),
      lastFour: lastFour(token),
      scope: 'uts:probe.read',
      lifetimeDays: 90,
    } as const,
  };
}

async function createdBotKey(holder: Session, orgId: string) {
  const { token, input } = botKeyInput(holder, orgId);
  const result = await account.createBotKey(input);
  if (result.outcome !== 'created') throw new Error(`expected created, got ${result.outcome}`);
  return { token, id: result.id };
}

/** `count` bot keys of `orgId`, created by `holder`, active or flagged `flaggedDaysAgo` days ago. */
async function insertBotKeys(
  holder: Session,
  orgId: string,
  count: number,
  flaggedDaysAgo: number | null = null
) {
  await owner.query(
    `WITH passes AS (
       INSERT INTO uts.gate_passes (account_id, device_session_id, tier, action, satisfied_by,
         expires_at, status, consumed_at)
       SELECT $1, $2, 'b', 'bot_key_create', '{recent_sign_in}', now() + interval '10 minutes',
         'consumed', now()
       FROM generate_series(1, $4::integer)
       RETURNING id
     )
     INSERT INTO uts.org_bot_keys (org_id, created_by, name, token_hash, last_four, audience, scope,
       gate_pass_id, created_at, expires_at, status, flagged_at)
     SELECT $3, $1, 'bulk', sha256(convert_to(id::text, 'UTF8')), 'wxyz', 'uts', 'uts:probe.read',
       id, now() - interval '10 days', now() + interval '30 days',
       CASE WHEN $5::integer IS NULL THEN 'active' ELSE 'flagged' END::uts.bot_key_status,
       now() - make_interval(days => $5::integer)
     FROM passes`,
    [holder.accountId, holder.deviceSessionId, orgId, count, flaggedDaysAgo]
  );
}

describe('org bot keys', () => {
  it('lets only an owner or admin create one, after a tier B gate', async () => {
    const { orgId, admin, member } = await organization();
    expect((await account.createBotKey(botKeyInput(member, orgId).input)).outcome).toBe(
      'not_org_admin'
    );
    const stale = await session({ accountId: admin.accountId, minutesAgo: 30 });
    expect((await account.createBotKey(botKeyInput(stale, orgId).input)).outcome).toBe(
      'gate_required'
    );
    const { token, id } = await createdBotKey(admin, orgId);
    const stored = await owner.query(
      `SELECT bot_key.org_id, bot_key.created_by, bot_key.status, pass.action, pass.status AS pass_status
       FROM uts.org_bot_keys AS bot_key JOIN uts.gate_passes AS pass ON pass.id = bot_key.gate_pass_id
       WHERE bot_key.id = $1`,
      [id]
    );
    expect(stored.rows).toEqual([
      {
        org_id: orgId,
        created_by: admin.accountId,
        status: 'active',
        action: 'bot_key_create',
        pass_status: 'consumed',
      },
    ]);
    expect(await lookupBotKey(new IdentityStore(patLogin), sha256(token))).toMatchObject({
      bot_key_id: id,
      org_id: orgId,
      status: 'active',
    });
    const rows = await auditRows(admin.accountId);
    expect(rows.map(row => row.type)).toEqual([
      'ai.kilo.uts.gate.refused',
      'ai.kilo.uts.bot_key.created',
    ]);
    expect(rows[1].event.data.attributes).toMatchObject({
      botKeyId: id,
      botKeyRef: reference(sha256(token)),
      org: orgId,
    });
    expect(await eventsText()).not.toContain(token);
  });

  it('keeps an organization at 100 live keys; a key flagged within 7 days counts, an older one not', async () => {
    const { orgId, admin } = await organization();
    await insertBotKeys(admin, orgId, 98);
    await insertBotKeys(admin, orgId, 1, 2);
    await insertBotKeys(admin, orgId, 1, 8);
    expect((await account.createBotKey(botKeyInput(admin, orgId).input)).outcome).toBe('created');
    expect((await account.createBotKey(botKeyInput(admin, orgId).input)).outcome).toBe(
      'limit_reached'
    );
  });

  it('puts two concurrent creates in one organization in order', async () => {
    const { orgId, admin } = await organization();
    await insertBotKeys(admin, orgId, 99);
    const first = await db.connect('uts_app_a');
    const second = await secondConnection();
    await first.query('BEGIN');
    try {
      const created = await identityStoreAccount(new IdentityStore(first)).createBotKey(
        botKeyInput(admin, orgId).input
      );
      expect(created.outcome).toBe('created');
      const racing = second.account.createBotKey(botKeyInput(admin, orgId).input);
      await waitUntilBlocked(second.pid);
      await first.query('COMMIT');
      expect((await racing).outcome).toBe('limit_reached');
    } finally {
      await first.query('ROLLBACK');
    }
  });

  it('lists the live keys for an admin only, and revokes with a feed entry', async () => {
    const { orgId, admin, member } = await organization();
    expect(await account.listBotKeys({ ...admin, orgId })).toEqual({
      outcome: 'listed',
      botKeys: [],
    });
    const { token, id } = await createdBotKey(admin, orgId);
    expect(await account.listBotKeys({ ...member, orgId })).toEqual({ outcome: 'not_org_admin' });
    const listed = await account.listBotKeys({ ...admin, orgId });
    expect(listed).toMatchObject({
      outcome: 'listed',
      botKeys: [
        { id, org: orgId, status: 'active', created_by: admin.accountId, last_used_at: null },
      ],
    });
    const revoke = (session: Session, keyId: string) =>
      account.revokeBotKey({ environment, ...session, orgId, keyId });
    expect(await revoke(member, id)).toEqual({ outcome: 'not_org_admin', feedEntries: [] });
    expect(await revoke(admin, id)).toEqual({
      outcome: 'revoked',
      feedEntries: [expect.objectContaining({ kind: 'bot_key', id, revokedBefore: null })],
    });
    expect(await revoke(admin, id)).toEqual({ outcome: 'already_revoked', feedEntries: [] });
    expect(await revoke(admin, randomUUID())).toEqual({ outcome: 'not_found', feedEntries: [] });
    expect(await lookupBotKey(new IdentityStore(patLogin), sha256(token))).toBeNull();
    const feed = await owner.query('SELECT kind FROM uts.revocations WHERE subject_id = $1', [id]);
    expect(feed.rows).toEqual([{ kind: 'bot_key' }]);
  });
});

describe('member removal', () => {
  it('flags the member’s keys, revokes org-bound PATs and grants, and tells every admin', async () => {
    const { orgId, admin, member } = await organization();
    await owner.query(`UPDATE uts.org_memberships SET role = 'admin' WHERE account_id = $1`, [
      member.accountId,
    ]);
    const memberKey = await createdBotKey(member, orgId);
    const keptKey = await createdBotKey(member, orgId);
    await owner.query(
      `UPDATE uts.org_bot_keys SET status = 'kept', flagged_at = now() - interval '1 day',
         kept_by = $2, kept_at = now()
       WHERE id = $1`,
      [keptKey.id, admin.accountId]
    );
    const adminKey = await createdBotKey(admin, orgId);
    const orgPat = await createdPat(member, { orgId });
    const personalPat = await createdPat(member);
    await owner.query('UPDATE uts.refresh_grants SET org_id = $2 WHERE id = $1', [
      member.grantId,
      orgId,
    ]);

    const removed = await app.query('SELECT * FROM uts.remove_org_member($1, $2, $3, 2)', [
      environment,
      orgId,
      member.accountId,
    ]);
    expect(removed.rows).toEqual([
      { outcome: 'removed', flagged_keys: 1, revoked_pats: 1, revoked_grants: 1 },
    ]);

    const keys = await owner.query(
      'SELECT id, status, flagged_at IS NOT NULL AS flagged FROM uts.org_bot_keys WHERE org_id = $1',
      [orgId]
    );
    expect(keys.rows).toEqual(
      expect.arrayContaining([
        { id: memberKey.id, status: 'flagged', flagged: true },
        { id: keptKey.id, status: 'kept', flagged: true },
        { id: adminKey.id, status: 'active', flagged: false },
      ])
    );
    // A flagged key still works until its 7-day cutoff.
    expect(await lookupBotKey(new IdentityStore(patLogin), sha256(memberKey.token))).toMatchObject({
      status: 'flagged',
    });
    expect(await lookupPat(new IdentityStore(patLogin), sha256(orgPat.token))).toBeNull();
    expect(await lookupPat(new IdentityStore(patLogin), sha256(personalPat.token))).not.toBeNull();
    const grant = await owner.query(
      'SELECT status, revoke_reason FROM uts.refresh_grants WHERE id = $1',
      [member.grantId]
    );
    expect(grant.rows).toEqual([{ status: 'revoked', revoke_reason: 'member_removed' }]);
    const feed = await owner.query(
      `SELECT kind FROM uts.revocations WHERE subject_id = ANY ($1::text[]) ORDER BY kind`,
      [[orgPat.id, member.grantId]]
    );
    expect(feed.rows).toEqual([{ kind: 'grant' }, { kind: 'pat' }]);

    const notices = await owner.query(
      `SELECT account_id, details FROM uts.notices WHERE kind = 'bot_key_flagged' ORDER BY account_id`
    );
    expect(notices.rows).toEqual([
      {
        account_id: admin.accountId,
        details: expect.objectContaining({ org: orgId, flaggedKeys: 1 }),
      },
    ]);
    const types = (await auditRows(member.accountId)).map(row => row.type);
    expect(types.slice(-4)).toEqual([
      'ai.kilo.uts.pat.revoked',
      'ai.kilo.uts.grant.revoked',
      'ai.kilo.uts.bot_key.flagged',
      'ai.kilo.uts.org_member.removed',
    ]);
    const flagged = (await auditRows(member.accountId)).find(
      row => row.type === 'ai.kilo.uts.bot_key.flagged'
    );
    expect(flagged?.event.data.actor).toEqual({ kind: 'system', id: 'uts' });

    for (const version of [2, 1]) {
      const again = await app.query('SELECT outcome FROM uts.remove_org_member($1, $2, $3, $4)', [
        environment,
        orgId,
        member.accountId,
        version,
      ]);
      expect(again.rows).toEqual([{ outcome: 'unchanged' }]);
    }
  });

  it('records a removal it holds no membership for, so a late added event cannot win', async () => {
    const holder = await session();
    const orgId = randomUUID();
    const result = await app.query('SELECT outcome FROM uts.remove_org_member($1, $2, $3, 5)', [
      environment,
      orgId,
      holder.accountId,
    ]);
    expect(result.rows).toEqual([{ outcome: 'recorded' }]);
    const row = await owner.query(
      'SELECT status, event_version FROM uts.org_memberships WHERE org_id = $1',
      [orgId]
    );
    expect(row.rows).toEqual([{ status: 'removed', event_version: 5n }]);
    const unknown = await app.query('SELECT outcome FROM uts.remove_org_member($1, $2, $3, 1)', [
      environment,
      orgId,
      `oauth/unknown-${randomUUID()}`,
    ]);
    expect(unknown.rows).toEqual([{ outcome: 'unchanged' }]);
  });

  it('lets an admin keep a flagged key before its cutoff, and not after', async () => {
    const { orgId, admin, member } = await organization();
    await owner.query(`UPDATE uts.org_memberships SET role = 'admin' WHERE account_id = $1`, [
      member.accountId,
    ]);
    const fresh = await createdBotKey(member, orgId);
    const lapsed = await createdBotKey(member, orgId);
    // A flag time never moves once set (`uts.refuse_reopening`), so the lapsed key is flagged 8
    // days back before the removal flags the fresh one.
    await owner.query(
      `UPDATE uts.org_bot_keys SET status = 'flagged', flagged_at = now() - interval '8 days'
       WHERE id = $1`,
      [lapsed.id]
    );
    await app.query('SELECT * FROM uts.remove_org_member($1, $2, $3, 2)', [
      environment,
      orgId,
      member.accountId,
    ]);
    const stale = await session({ accountId: admin.accountId, minutesAgo: 30 });
    expect(await account.keepBotKey({ environment, ...stale, orgId, keyId: fresh.id })).toBe(
      'gate_required'
    );
    const refused = (await auditRows(admin.accountId)).find(
      row => row.type === 'ai.kilo.uts.gate.refused'
    );
    expect(refused?.event.data.attributes).toMatchObject({ action: 'bot_key_keep', tier: 'b' });
    const keep = (keyId: string) => account.keepBotKey({ environment, ...admin, orgId, keyId });
    expect(await keep(fresh.id)).toBe('kept');
    expect(await keep(fresh.id)).toBe('not_flagged');
    expect(await keep(lapsed.id)).toBe('lapsed');
    expect(await keep(randomUUID())).toBe('not_found');
    expect(await lookupBotKey(new IdentityStore(patLogin), sha256(fresh.token))).toMatchObject({
      status: 'kept',
    });
    expect(await lookupBotKey(new IdentityStore(patLogin), sha256(lapsed.token))).toBeNull();
    const listed = await account.listBotKeys({ ...admin, orgId });
    expect(listed).toMatchObject({
      outcome: 'listed',
      botKeys: [{ id: fresh.id, status: 'kept', kept_by: admin.accountId }],
    });
  });

  it('revokes an org-bound PAT whose create was still open when the removal arrived', async () => {
    const { orgId, member } = await organization();
    const creator = await db.connect('uts_app_a');
    const remover = await secondConnection();
    await creator.query('BEGIN');
    try {
      const { token, input } = patInput(member, { orgId });
      const created = await identityStoreAccount(new IdentityStore(creator)).createPat(input);
      expect(created.outcome).toBe('created');
      const removal = remover.client.query('SELECT * FROM uts.remove_org_member($1, $2, $3, 2)', [
        environment,
        orgId,
        member.accountId,
      ]);
      await waitUntilBlocked(remover.pid);
      await creator.query('COMMIT');
      expect((await removal).rows).toEqual([
        { outcome: 'removed', flagged_keys: 0, revoked_pats: 1, revoked_grants: 0 },
      ]);
      expect(await lookupPat(new IdentityStore(patLogin), sha256(token))).toBeNull();
    } finally {
      await creator.query('ROLLBACK');
    }
  });

  it('flags a bot key whose create was still open when its creator was removed', async () => {
    const { orgId, admin } = await organization();
    const creator = await db.connect('uts_app_a');
    const remover = await secondConnection();
    await creator.query('BEGIN');
    try {
      const { input } = botKeyInput(admin, orgId);
      const created = await identityStoreAccount(new IdentityStore(creator)).createBotKey(input);
      expect(created.outcome).toBe('created');
      const removal = remover.client.query('SELECT * FROM uts.remove_org_member($1, $2, $3, 2)', [
        environment,
        orgId,
        admin.accountId,
      ]);
      await waitUntilBlocked(remover.pid);
      await creator.query('COMMIT');
      expect((await removal).rows).toEqual([
        { outcome: 'removed', flagged_keys: 1, revoked_pats: 0, revoked_grants: 0 },
      ]);
      const key = await owner.query('SELECT status FROM uts.org_bot_keys WHERE org_id = $1', [
        orgId,
      ]);
      expect(key.rows).toEqual([{ status: 'flagged' }]);
    } finally {
      await creator.query('ROLLBACK');
    }
  });

  it('refuses a create that waited for a removal of the same member', async () => {
    const { orgId, member } = await organization();
    const remover = await db.connect('uts_app_a');
    const creator = await secondConnection();
    await remover.query('BEGIN');
    try {
      await remover.query('SELECT * FROM uts.remove_org_member($1, $2, $3, 2)', [
        environment,
        orgId,
        member.accountId,
      ]);
      const creating = creator.account.createPat(patInput(member, { orgId }).input);
      await waitUntilBlocked(creator.pid);
      await remover.query('COMMIT');
      expect((await creating).outcome).toBe('org_denied');
    } finally {
      await remover.query('ROLLBACK');
    }
  });
});

/**
 * A pending tier A code for `emailHash`, whose keyed hash is `codeHash`, sent to the account's
 * primary address (`current`) or to the new address of an email change (`new`).
 */
async function tierACode(
  accountId: string,
  emailHash: Buffer,
  codeHash: Buffer,
  address: 'current' | 'new' = 'current'
) {
  await owner.query(
    `INSERT INTO uts.email_codes (purpose, email_hash, account_id, code_hash, expires_at, address)
     VALUES ('tier_a', $1, $2, $3, now() + interval '10 minutes', $4)`,
    [emailHash, accountId, codeHash, address]
  );
}

async function openTierA(
  holder: Session,
  action: string,
  codes: { email: Buffer; code: Buffer; newEmail?: Buffer; newCode?: Buffer }
) {
  const result = await app.query<{ outcome: string; gate_pass_id: string | null }>(
    'SELECT outcome, gate_pass_id FROM uts.open_tier_a_gate_pass($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      environment,
      holder.accountId,
      holder.grantId,
      action,
      codes.email,
      codes.code,
      codes.newEmail ?? null,
      codes.newCode ?? null,
    ]
  );
  return result.rows[0];
}

async function codeState(emailHash: Buffer) {
  const result = await owner.query(
    'SELECT status, attempts FROM uts.email_codes WHERE email_hash = $1',
    [emailHash]
  );
  return result.rows;
}

describe('tier A gate passes', () => {
  it('open after a recent strongest-method sign-in and the emailed code, which is consumed', async () => {
    const holder = await session({ amr: ['oauth'] });
    const [email, code] = [randomBytes(32), randomBytes(32)];
    await tierACode(holder.accountId, email, code);
    const opened = await openTierA(holder, 'passkey_add', { email, code });
    expect(opened.outcome).toBe('opened');
    const pass = await owner.query(
      `SELECT tier, action, status, satisfied_by::text[] AS satisfied_by FROM uts.gate_passes WHERE id = $1`,
      [opened.gate_pass_id]
    );
    expect(pass.rows).toEqual([
      {
        tier: 'a',
        action: 'passkey_add',
        status: 'open',
        satisfied_by: ['recent_sign_in', 'email_code'],
      },
    ]);
    expect(await codeState(email)).toEqual([{ status: 'consumed', attempts: 0 }]);
    expect((await auditRows(holder.accountId)).map(row => row.type)).toEqual([
      'ai.kilo.uts.gate.passed',
    ]);
  });

  it('need the passkey sign-in on an account that holds a passkey, within 10 minutes', async () => {
    const holder = await session({ amr: ['oauth'] });
    await owner.query(
      `INSERT INTO uts.passkey_credentials (account_id, credential_id, public_key, backup_eligible,
         backed_up, rp_id, name, added_at)
       VALUES ($1, $2, $3, false, false, 'app.kilo.ai', 'laptop', now() - interval '30 days')`,
      [holder.accountId, randomBytes(32), randomBytes(32)]
    );
    const [email, code] = [randomBytes(32), randomBytes(32)];
    await tierACode(holder.accountId, email, code);
    expect((await openTierA(holder, 'method_add', { email, code })).outcome).toBe('gate_required');
    const passkeySession = await session({ accountId: holder.accountId, amr: ['passkey'] });
    const stale = await session({ accountId: holder.accountId, amr: ['passkey'], minutesAgo: 11 });
    expect((await openTierA(stale, 'method_add', { email, code })).outcome).toBe('gate_required');
    expect(await codeState(email)).toEqual([{ status: 'pending', attempts: 0 }]);
    expect((await openTierA(passkeySession, 'method_add', { email, code })).outcome).toBe('opened');
  });

  it('block removing a method or changing the email for 24 hours after a method was added', async () => {
    const holder = await session({ amr: ['oauth'] });
    await owner.query(
      `INSERT INTO uts.sign_in_methods (account_id, provider, provider_subject, added_at)
       VALUES ($1, 'github', $2, now() - interval '1 hour')`,
      [holder.accountId, randomUUID()]
    );
    const [email, code] = [randomBytes(32), randomBytes(32)];
    await tierACode(holder.accountId, email, code);
    for (const action of ['method_remove', 'passkey_remove'] as const) {
      expect((await openTierA(holder, action, { email, code })).outcome).toBe('cooling_off');
    }
    expect(await codeState(email)).toEqual([{ status: 'pending', attempts: 0 }]);
    expect((await openTierA(holder, 'passkey_add', { email, code })).outcome).toBe('opened');
  });

  it('count a wrong code as an attempt and exhaust the code after 5', async () => {
    const holder = await session({ amr: ['oauth'] });
    const [email, code] = [randomBytes(32), randomBytes(32)];
    await tierACode(holder.accountId, email, code);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(
        (await openTierA(holder, 'method_add', { email, code: randomBytes(32) })).outcome
      ).toBe('code_invalid');
    }
    expect(await codeState(email)).toEqual([{ status: 'exhausted', attempts: 5 }]);
    expect((await openTierA(holder, 'method_add', { email, code })).outcome).toBe('code_invalid');
  });

  it('need both codes for an email change and consume neither when one is wrong', async () => {
    const holder = await session({ amr: ['oauth'] });
    const [email, code, newEmail, newCode] = [0, 1, 2, 3].map(() => randomBytes(32));
    await tierACode(holder.accountId, email, code);
    await tierACode(holder.accountId, newEmail, newCode, 'new');
    expect(
      (await openTierA(holder, 'email_change', { email, code, newEmail, newCode: randomBytes(32) }))
        .outcome
    ).toBe('code_invalid');
    expect(await codeState(email)).toEqual([{ status: 'pending', attempts: 0 }]);
    expect(await codeState(newEmail)).toEqual([{ status: 'pending', attempts: 1 }]);
    const opened = await openTierA(holder, 'email_change', { email, code, newEmail, newCode });
    expect(opened.outcome).toBe('opened');
    const pass = await owner.query(
      'SELECT satisfied_by::text[] AS satisfied_by FROM uts.gate_passes WHERE id = $1',
      [opened.gate_pass_id]
    );
    expect(pass.rows).toEqual([
      { satisfied_by: ['recent_sign_in', 'email_code', 'email_code_new'] },
    ]);
  });

  it('never count a code sent to a new address as the code to the primary address', async () => {
    const holder = await session({ amr: ['oauth'] });
    const [email, code, newEmail, newCode, otherEmail, otherCode] = [0, 1, 2, 3, 4, 5].map(() =>
      randomBytes(32)
    );
    await tierACode(holder.accountId, email, code);
    await tierACode(holder.accountId, newEmail, newCode, 'new');
    await tierACode(holder.accountId, otherEmail, otherCode, 'new');
    // The new address's code as the primary one, beside another new address the caller holds.
    expect(
      (
        await openTierA(holder, 'email_change', {
          email: newEmail,
          code: newCode,
          newEmail: otherEmail,
          newCode: otherCode,
        })
      ).outcome
    ).toBe('code_invalid');
    // A code left from an abandoned email change does not open any other tier A action.
    expect(
      (await openTierA(holder, 'method_add', { email: newEmail, code: newCode })).outcome
    ).toBe('code_invalid');
    // The primary address's code is not a new address's code either.
    expect(
      (
        await openTierA(holder, 'email_change', {
          email: otherEmail,
          code: otherCode,
          newEmail: email,
          newCode: code,
        })
      ).outcome
    ).toBe('code_invalid');
    expect(await codeState(email)).toEqual([{ status: 'pending', attempts: 0 }]);
  });

  it('refuse an email change to the same address', async () => {
    const holder = await session({ amr: ['oauth'] });
    const [email, code] = [randomBytes(32), randomBytes(32)];
    await tierACode(holder.accountId, email, code);
    expect(
      await sqlStateOf(() =>
        openTierA(holder, 'email_change', { email, code, newEmail: email, newCode: code })
      )
    ).toBe('22023');
  });

  it('refuse a tier B action, and a new address on any action but an email change', async () => {
    const holder = await session({ amr: ['oauth'] });
    const codes = { email: randomBytes(32), code: randomBytes(32) };
    expect(await sqlStateOf(() => openTierA(holder, 'pat_create', codes))).toBe('22023');
    expect(
      await sqlStateOf(() =>
        openTierA(holder, 'method_add', {
          ...codes,
          newEmail: randomBytes(32),
          newCode: randomBytes(32),
        })
      )
    ).toBe('22023');
    expect(await sqlStateOf(() => openTierA(holder, 'email_change', codes))).toBe('22023');
  });
});
