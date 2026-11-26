import { randomBytes, randomUUID } from 'node:crypto';
import type { AccountImportRequest, SubjectOperation } from '@kilocode/uts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityStore } from '../../src/db/client';
import type { FeedEntry } from '../../src/revocation/entries';
import { identityStoreSsoAuthority } from '../../src/subjects/authority';
import { type SubjectStore, identityStoreSubjects } from '../../src/subjects/store';
import { TestDatabase, insertAccount, insertGatePass, sqlStateOf } from './harness';

/**
 * Identity import, authority sync, subject operations and the user-created event (migration 0014)
 * through the Worker's own statements (`src/subjects/store.ts`), run as the app login. Fixtures
 * that other slices write (sessions, grants, PATs, families, bot keys) are inserted as the owner.
 */

let db: TestDatabase;
let owner: pg.Client;
let app: pg.Client;
let subjects: SubjectStore;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  app = await db.connect('uts_app_a');
  subjects = identityStoreSubjects(new IdentityStore(app));
});
afterAll(() => db.drop());

const environment = 'development';
const workload = 'web';
const actor = 'admin:staff-1';

function operation(
  op: SubjectOperation,
  subject: string,
  reason: string,
  sourceVersion: number,
  operationId: string = randomUUID()
) {
  return subjects.applyOperation({
    environment,
    workload,
    operation: op,
    operationId,
    subject,
    reason,
    actor,
    sourceVersion,
  });
}

function kindsOf(entries: readonly FeedEntry[]) {
  return entries.map(entry => entry.kind).sort();
}

/** Every credential a signed-in user can hold, as the sign-in and account slices write them. */
async function credentials(accountId: string) {
  const browser = await owner.query<{ id: string }>(
    `INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
     VALUES ($1, $2, now(), '{oauth}', now() + interval '14 days', now() + interval '30 days')
     RETURNING id`,
    [accountId, randomBytes(32)]
  );
  const grant = async (clientId: string, clientClass: 'desktop' | 'mobile') => {
    const device = await owner.query<{ id: string }>(
      `INSERT INTO uts.device_sessions (account_id, client_class, device_label, platform, auth_time, amr)
       VALUES ($1, $2, 'test device', 'linux', now(), '{passkey}') RETURNING id`,
      [accountId, clientClass]
    );
    const row = await owner.query<{ id: string }>(
      `INSERT INTO uts.refresh_grants (account_id, device_session_id, client_id, client_class,
         token_hash, dpop_jkt, allowed_scopes, idle_expires_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, '{uts:pats.manage}', now() + interval '30 days',
         now() + interval '180 days')
       RETURNING id`,
      [accountId, device.rows[0].id, clientId, clientClass, randomBytes(32), randomBytes(32)]
    );
    return row.rows[0].id;
  };
  const cli = await grant('kilo-cli', 'desktop');
  const mobile = await grant('kilo-mobile', 'mobile');
  const pat = await owner.query<{ id: string }>(
    `INSERT INTO uts.personal_access_tokens (account_id, name, token_hash, last_four, audience,
       scope, gate_pass_id, expires_at)
     VALUES ($1, 'test', $2, 'abcd', 'uts', 'uts:probe.read', $3, now() + interval '30 days')
     RETURNING id`,
    [accountId, randomBytes(32), await insertGatePass(owner, accountId, 'pat_create')]
  );
  const clientId = `https://client.example.com/${randomUUID()}`;
  await owner.query(
    `INSERT INTO uts.third_party_clients (client_id, client_name, redirect_uris, document,
       fetched_at, cache_expires_at)
     VALUES ($1, 'Test client', '{https://client.example.com/cb}', '{}', now(), now() + interval '1 day')`,
    [clientId]
  );
  const consent = await owner.query<{ id: string }>(
    `INSERT INTO uts.third_party_consents (account_id, client_id, scopes, gate_pass_id)
     VALUES ($1, $2, '{uts:probe.read}', $3) RETURNING id`,
    [accountId, clientId, await insertGatePass(owner, accountId, 'third_party_approve')]
  );
  const family = await owner.query<{ id: string }>(
    `INSERT INTO uts.third_party_grant_families (account_id, client_id, consent_id, scopes,
       auth_time, amr, expires_at)
     VALUES ($1, $2, $3, '{uts:probe.read}', now(), '{oauth}', now() + interval '90 days')
     RETURNING id`,
    [accountId, clientId, consent.rows[0].id]
  );
  return {
    browser: browser.rows[0].id,
    cli,
    mobile,
    pat: pat.rows[0].id,
    family: family.rows[0].id,
  };
}

async function statuses(accountId: string) {
  const result = await owner.query<{ kind: string; status: string }>(
    `SELECT 'browser' AS kind, status::text FROM uts.browser_sessions WHERE account_id = $1
     UNION ALL SELECT client_id, status::text FROM uts.refresh_grants WHERE account_id = $1
     UNION ALL SELECT 'pat', status::text FROM uts.personal_access_tokens WHERE account_id = $1
     UNION ALL SELECT 'family', status::text FROM uts.third_party_grant_families WHERE account_id = $1`,
    [accountId]
  );
  return Object.fromEntries(result.rows.map(row => [row.kind, row.status]));
}

async function accountRow(accountId: string) {
  const result = await owner.query<{
    status: string;
    status_version: bigint;
    email_version: bigint;
    revoked_before: Date | null;
    blocked_at: Date | null;
  }>(
    `SELECT status, status_version, email_version, revoked_before, blocked_at
     FROM uts.accounts WHERE id = $1`,
    [accountId]
  );
  return result.rows[0] ?? null;
}

async function auditTypes(accountId: string) {
  const result = await owner.query<{ event_type: string; actor: unknown }>(
    `SELECT event_type, event #> '{data,actor}' AS actor FROM uts.audit_events
     WHERE account_id = $1 ORDER BY id`,
    [accountId]
  );
  return result.rows;
}

function importRequest(overrides: Partial<AccountImportRequest> = {}): AccountImportRequest {
  return {
    app_user_id: `oauth/google:${randomUUID()}`,
    primary_email: `${randomBytes(5).toString('hex')}@example.com`,
    status: 'active',
    verified_identities: [
      {
        provider: 'google',
        provider_subject: randomUUID(),
        verified_email: null,
        workos_connection_id: null,
        linked_at: '2025-01-02T03:04:05Z',
      },
    ],
    sso_authority: null,
    passkeys: [],
    source_version: 0,
    ...overrides,
  };
}

const importAccount = (request: AccountImportRequest) =>
  subjects.importAccount({ environment, workload, request, rpId: 'localhost' });

async function syncSso(orgId: string, workosOrg: string, connections: string[], version: number) {
  return await subjects.syncSsoOrganization({
    environment,
    workload,
    operationId: randomUUID(),
    actor: 'system:scim',
    sourceVersion: version,
    orgId,
    workosOrganizationId: workosOrg,
    workosConnectionIds: connections,
    enforcement: 'required',
  });
}

describe('uts.import_account', () => {
  it('keeps the app user id, the identities, the passkeys and the SSO tie, once', async () => {
    const orgId = randomUUID();
    const workosOrg = `org_${randomUUID()}`;
    const connection = `conn_${randomUUID()}`;
    expect((await syncSso(orgId, workosOrg, [connection], 1)).outcome).toBe('applied');
    const handle = randomBytes(32).toString('base64url');
    const request = importRequest({
      verified_identities: [
        {
          provider: 'github',
          provider_subject: randomUUID(),
          verified_email: null,
          workos_connection_id: null,
          linked_at: '2024-05-06T07:08:09Z',
        },
        {
          provider: 'workos',
          provider_subject: `prof_${randomUUID()}`,
          verified_email: 'member@example.com',
          workos_connection_id: connection,
          linked_at: '2025-05-06T07:08:09Z',
        },
      ],
      sso_authority: {
        app_organization_id: orgId,
        workos_organization_id: workosOrg,
        workos_connection_id: connection,
        role: 'member',
      },
      passkeys: [
        {
          credential_id: randomBytes(32).toString('base64url'),
          public_key: randomBytes(77).toString('base64url'),
          sign_count: 7,
          transports: ['internal', 'hybrid'],
          backup_eligible: true,
          backed_up: true,
          aaguid: null,
          name: 'Laptop',
          user_handle: handle,
          created_at: '2025-07-01T00:00:00Z',
        },
      ],
      source_version: 12,
    });
    expect(await importAccount(request)).toEqual({ outcome: 'imported' });
    expect(await importAccount(request)).toEqual({ outcome: 'already_imported' });

    const account = await accountRow(request.app_user_id);
    expect(account).toMatchObject({
      status: 'active',
      status_version: 12n,
      email_version: 12n,
      revoked_before: null,
    });
    const methods = await owner.query<{ provider: string; added_at: Date; sso: boolean }>(
      `SELECT provider::text, added_at, sso_connection_id IS NOT NULL AS sso FROM uts.sign_in_methods
       WHERE account_id = $1 ORDER BY provider`,
      [request.app_user_id]
    );
    expect(methods.rows).toEqual([
      { provider: 'github', added_at: new Date('2024-05-06T07:08:09Z'), sso: false },
      { provider: 'workos', added_at: new Date('2025-05-06T07:08:09Z'), sso: true },
    ]);
    const passkeys = await owner.query<{ handle: string; gate: string | null; rp_id: string }>(
      `SELECT encode(user_handle, 'base64') AS handle, gate_pass_id AS gate, rp_id
       FROM uts.passkey_credentials WHERE account_id = $1`,
      [request.app_user_id]
    );
    expect(passkeys.rows).toEqual([
      {
        handle: Buffer.from(handle, 'base64url').toString('base64'),
        gate: null,
        rp_id: 'localhost',
      },
    ]);
    const check = identityStoreSsoAuthority(new IdentityStore(app));
    expect(
      await check({
        subject: request.app_user_id,
        workosConnectionId: connection,
        workosOrganizationId: workosOrg,
      })
    ).toEqual({ status: 'verified', appOrganizationId: orgId });
    const audit = await auditTypes(request.app_user_id);
    expect(audit).toEqual([
      { event_type: 'ai.kilo.uts.account.imported', actor: { kind: 'workload', id: 'web' } },
    ]);
    const events = await owner.query('SELECT 1 FROM uts.app_account_events WHERE account_id = $1', [
      request.app_user_id,
    ]);
    expect(events.rowCount).toBe(0);
  });

  it('waits for the SSO sync, and refuses a tie the sync does not hold, writing nothing', async () => {
    const connection = `conn_${randomUUID()}`;
    const orgId = randomUUID();
    const tie = {
      app_organization_id: orgId,
      workos_organization_id: 'org_a',
      workos_connection_id: connection,
      role: 'member' as const,
    };
    const request = importRequest({ sso_authority: tie });
    expect(await importAccount(request)).toEqual({
      outcome: 'retry_later',
      error: 'sso_connection_unknown',
    });
    await syncSso(orgId, 'org_b', [connection], 1);
    expect(await importAccount(request)).toEqual({
      outcome: 'refused',
      error: 'sso_authority_mismatch',
    });
    expect(await accountRow(request.app_user_id)).toBeNull();
  });

  it('refuses an identity, an address or a passkey another account holds', async () => {
    const first = importRequest({
      passkeys: [
        {
          credential_id: randomBytes(32).toString('base64url'),
          public_key: randomBytes(77).toString('base64url'),
          sign_count: 0,
          transports: [],
          backup_eligible: false,
          backed_up: false,
          aaguid: randomUUID(),
          name: 'Key',
          user_handle: randomBytes(32).toString('base64url'),
          created_at: '2025-07-01T00:00:00Z',
        },
      ],
    });
    expect((await importAccount(first)).outcome).toBe('imported');
    expect(
      await importAccount(importRequest({ verified_identities: first.verified_identities }))
    ).toEqual({ outcome: 'refused', error: 'identity_taken' });
    expect(await importAccount(importRequest({ primary_email: first.primary_email }))).toEqual({
      outcome: 'refused',
      error: 'email_taken',
    });
    expect(await importAccount(importRequest({ passkeys: first.passkeys }))).toEqual({
      outcome: 'refused',
      error: 'passkey_taken',
    });
  });

  it('refuses a uts_ id, which only UTS sign-in creates', async () => {
    const request = importRequest({ app_user_id: `uts_${'a'.repeat(26)}` });
    await expect(importAccount(request)).rejects.toMatchObject({ sqlState: '22023' });
  });
});

describe('tombstones and source versions', () => {
  it('imports a subject blocked before its import as blocked, with revoked_before', async () => {
    const request = importRequest({ source_version: 3 });
    expect(await operation('revoke', request.app_user_id, 'access_block', 3)).toEqual({
      outcome: 'no_subject',
      feedEntries: [],
    });
    const tombstone = await owner.query<{ created_at: Date }>(
      'SELECT created_at FROM uts.subject_tombstones WHERE subject = $1',
      [request.app_user_id]
    );
    expect(await importAccount(request)).toEqual({ outcome: 'imported' });
    const account = await accountRow(request.app_user_id);
    expect(account).toMatchObject({
      status: 'blocked',
      blocked_at: tombstone.rows[0].created_at,
      revoked_before: tombstone.rows[0].created_at,
      status_version: 3n,
    });
    const left = await owner.query('SELECT 1 FROM uts.subject_tombstones WHERE subject = $1', [
      request.app_user_id,
    ]);
    expect(left.rowCount).toBe(0);
  });

  it('imports a subject blocked and unblocked before its import as active', async () => {
    const request = importRequest({ source_version: 5 });
    await operation('revoke', request.app_user_id, 'access_block', 4);
    await operation('unblock', request.app_user_id, 'access_unblock', 5);
    expect(await importAccount(request)).toEqual({ outcome: 'imported' });
    expect(await accountRow(request.app_user_id)).toMatchObject({ status: 'active' });
  });

  it('refuses an import older than an operation that reached UTS first', async () => {
    const request = importRequest({ source_version: 6 });
    await operation('end-browser-sessions', request.app_user_id, 'staff_signout', 7);
    expect(await importAccount(request)).toEqual({ outcome: 'refused', error: 'stale' });
    expect(await importAccount({ ...request, source_version: 7 })).toEqual({
      outcome: 'imported',
    });
  });

  it('refuses a deleted subject for good, after its operation id is gone too', async () => {
    const request = importRequest({ source_version: 1 });
    const deletion = randomUUID();
    expect(await operation('revoke', request.app_user_id, 'account_deleted', 2, deletion)).toEqual({
      outcome: 'no_subject',
      feedEntries: [],
    });
    await owner.query(
      "UPDATE uts.subject_operations SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE operation_id = $1",
      [deletion]
    );
    const maintained = await app.query<{ kind: string; deleted: number }>(
      'SELECT kind, deleted FROM uts.maintain_subject_operation_rows()'
    );
    expect(maintained.rows[0]).toMatchObject({ kind: 'subject_operations' });
    expect(maintained.rows[0].deleted).toBeGreaterThanOrEqual(1);
    expect(await importAccount({ ...request, source_version: 99 })).toEqual({
      outcome: 'refused',
      error: 'deleted',
    });
    expect(await operation('unblock', request.app_user_id, 'access_unblock', 100)).toEqual({
      outcome: 'refused',
      error: 'account_deleted',
    });
    expect((await operation('revoke', request.app_user_id, 'account_deleted', 100)).outcome).toBe(
      'already_applied'
    );
  });
});

describe('uts.apply_subject_operation', () => {
  it('blocks: everything revoked, the account blocked, every entry for the feed', async () => {
    const accountId = await insertAccount(owner);
    const held = await credentials(accountId);
    const operationId = randomUUID();
    const blocked = await operation('revoke', accountId, 'access_block', 1, operationId);
    if (blocked.outcome !== 'applied') throw new Error(`block answered ${blocked.outcome}`);
    const ids = (kind: FeedEntry['kind']) =>
      blocked.feedEntries
        .filter(entry => entry.kind === kind)
        .map(entry => entry.id)
        .sort();
    expect(ids('subject')).toEqual([accountId]);
    expect(ids('blocked_account')).toEqual([accountId]);
    expect(ids('grant')).toEqual([held.cli, held.mobile].sort());
    expect(ids('pat')).toEqual([held.pat]);
    expect(ids('third_party_family')).toEqual([held.family]);
    // The fixture's gate passes sit on two more browser sessions, which end too.
    expect(ids('session')).toContain(held.browser);
    expect(ids('session')).toHaveLength(3);
    const subject = blocked.feedEntries.find(entry => entry.kind === 'subject');
    expect(subject?.expiresAt).toBe((subject?.revokedAt ?? 0) + 70 * 60_000);
    expect(await statuses(accountId)).toEqual({
      browser: 'revoked',
      'kilo-cli': 'revoked',
      'kilo-mobile': 'revoked',
      pat: 'revoked',
      family: 'revoked',
    });
    expect(await accountRow(accountId)).toMatchObject({ status: 'blocked', status_version: 1n });
    expect((await auditTypes(accountId)).at(-1)).toEqual({
      event_type: 'ai.kilo.uts.subject.revoked',
      actor: { kind: 'workload', id: 'web' },
    });

    // The same operation id hands the same entries to the feed again; a new id finds the block.
    expect(await operation('revoke', accountId, 'access_block', 1, operationId)).toEqual({
      outcome: 'already_applied',
      feedEntries: blocked.feedEntries,
    });
    expect(await operation('revoke', accountId, 'access_block', 2)).toEqual({
      outcome: 'already_applied',
      feedEntries: [],
    });
    // An operation id names one operation of one subject.
    await expect(
      operation('end-browser-sessions', accountId, 'staff_signout', 3, operationId)
    ).rejects.toMatchObject({ sqlState: '22023' });
    // A revocation is terminal: nothing moves a revoked row back.
    for (const table of [
      'browser_sessions',
      'refresh_grants',
      'personal_access_tokens',
      'third_party_grant_families',
    ]) {
      expect(
        await sqlStateOf(() =>
          owner.query(`UPDATE uts.${table} SET status = 'active' WHERE account_id = $1`, [
            accountId,
          ])
        )
      ).toBe('23514');
    }
  });

  it('refuses an unblock under 60 seconds, then unblocks without restoring a grant', async () => {
    const accountId = await insertAccount(owner);
    await credentials(accountId);
    await operation('revoke', accountId, 'access_block', 1);
    const early = await operation('unblock', accountId, 'access_unblock', 2);
    if (early.outcome !== 'retry_later') throw new Error(`early unblock answered ${early.outcome}`);
    expect(early.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(early.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(await accountRow(accountId)).toMatchObject({ status: 'blocked' });

    await owner.query(
      "UPDATE uts.accounts SET blocked_at = now() - interval '61 seconds' WHERE id = $1",
      [accountId]
    );
    const unblocked = await operation('unblock', accountId, 'access_unblock', 2);
    if (unblocked.outcome !== 'applied') throw new Error(`unblock answered ${unblocked.outcome}`);
    expect(kindsOf(unblocked.feedEntries)).toEqual(['blocked_account', 'unblocked_account']);
    const [block, unblock] = ['blocked_account', 'unblocked_account'].map(kind =>
      unblocked.feedEntries.find(entry => entry.kind === kind)
    );
    expect(block?.revokedAt).toBe(unblock?.revokedAt);
    expect((unblock?.expiresAt ?? 0) - (block?.expiresAt ?? 0)).toBe(10 * 60_000);
    expect(await accountRow(accountId)).toMatchObject({ status: 'active', blocked_at: null });
    expect(Object.values(await statuses(accountId)).every(status => status === 'revoked')).toBe(
      true
    );
    // An unblock of an account that is not blocked changes nothing.
    expect((await operation('unblock', accountId, 'access_unblock', 3)).outcome).toBe(
      'already_applied'
    );
  });

  it('applies a block or an unblock only at or above the newest source version', async () => {
    const accountId = await insertAccount(owner);
    await operation('revoke', accountId, 'access_block', 10);
    expect((await operation('unblock', accountId, 'access_unblock', 9)).outcome).toBe(
      'already_applied'
    );
    expect(await accountRow(accountId)).toMatchObject({ status: 'blocked', status_version: 10n });
    await owner.query(
      "UPDATE uts.accounts SET blocked_at = now() - interval '61 seconds' WHERE id = $1",
      [accountId]
    );
    expect((await operation('unblock', accountId, 'access_unblock', 12)).outcome).toBe('applied');
    expect((await operation('revoke', accountId, 'access_block', 11)).outcome).toBe(
      'already_applied'
    );
    expect(await accountRow(accountId)).toMatchObject({ status: 'active', status_version: 12n });
    // A revocation applies whatever its version: it only takes access away.
    const recovery = await operation('revoke', accountId, 'account_recovery', 1);
    expect(recovery.outcome).toBe('applied');
    expect((await accountRow(accountId))?.revoked_before).not.toBeNull();
  });

  it('ends browser sessions only, device sessions only, or PATs only', async () => {
    const accountId = await insertAccount(owner);
    await credentials(accountId);
    const browser = await operation('end-browser-sessions', accountId, 'workos_relink', 1);
    if (browser.outcome !== 'applied') throw new Error(`browser end answered ${browser.outcome}`);
    expect(new Set(kindsOf(browser.feedEntries))).toEqual(new Set(['session']));
    expect(await statuses(accountId)).toMatchObject({
      browser: 'revoked',
      'kilo-cli': 'active',
      'kilo-mobile': 'active',
      pat: 'active',
    });
    const device = await operation('end-device-sessions', accountId, 'apple_consent_revoked', 2);
    if (device.outcome !== 'applied') throw new Error(`device end answered ${device.outcome}`);
    expect(kindsOf(device.feedEntries)).toEqual(['grant', 'grant']);
    expect(await statuses(accountId)).toMatchObject({
      'kilo-cli': 'revoked',
      'kilo-mobile': 'revoked',
      pat: 'active',
      family: 'active',
    });
    const pats = await operation('revoke-api-credentials', accountId, 'staff_api_reset', 3);
    if (pats.outcome !== 'applied') throw new Error(`PAT revoke answered ${pats.outcome}`);
    expect(kindsOf(pats.feedEntries)).toEqual(['pat']);
    expect(await statuses(accountId)).toMatchObject({ pat: 'revoked', family: 'active' });
    expect((await accountRow(accountId))?.revoked_before).toBeNull();
    // Nothing left to end: the effect already holds.
    expect(await operation('end-browser-sessions', accountId, 'staff_signout', 4)).toEqual({
      outcome: 'already_applied',
      feedEntries: [],
    });
    await expect(
      operation('end-device-sessions', accountId, 'staff_signout', 5)
    ).rejects.toMatchObject({ sqlState: '22023' });
  });

  it('deletes: revokes, lists the subject for 24 hours, flags bot keys, removes the row for good', async () => {
    const accountId = await insertAccount(owner);
    const adminId = await insertAccount(owner);
    const orgId = randomUUID();
    await owner.query(
      `INSERT INTO uts.org_memberships (org_id, account_id, role, event_version)
       VALUES ($1, $2, 'member', 1), ($1, $3, 'admin', 1)`,
      [orgId, accountId, adminId]
    );
    await owner.query(
      `INSERT INTO uts.org_bot_keys (org_id, created_by, name, token_hash, last_four, audience,
         scope, gate_pass_id, expires_at)
       VALUES ($1, $2, 'bot', $3, 'wxyz', 'uts', 'uts:probe.read', $4, now() + interval '30 days')`,
      [orgId, accountId, randomBytes(32), await insertGatePass(owner, accountId, 'bot_key_create')]
    );
    await credentials(accountId);
    const deleted = await operation('revoke', accountId, 'account_deleted', 4);
    if (deleted.outcome !== 'applied') throw new Error(`deletion answered ${deleted.outcome}`);
    for (const kind of ['subject', 'blocked_account'] as const) {
      const entry = deleted.feedEntries.find(item => item.kind === kind);
      expect(entry?.expiresAt).toBe((entry?.revokedAt ?? 0) + 24 * 3_600_000);
    }
    expect(await accountRow(accountId)).toBeNull();
    const flagged = await owner.query<{ status: string }>(
      'SELECT status::text FROM uts.org_bot_keys WHERE created_by = $1',
      [accountId]
    );
    expect(flagged.rows).toEqual([{ status: 'flagged' }]);
    const notices = await owner.query(
      "SELECT 1 FROM uts.notices WHERE account_id = $1 AND kind = 'bot_key_flagged'",
      [adminId]
    );
    expect(notices.rowCount).toBe(1);
    expect((await auditTypes(accountId)).map(row => row.event_type).slice(-2)).toEqual([
      'ai.kilo.uts.bot_key.flagged',
      'ai.kilo.uts.subject.revoked',
    ]);
    expect((await operation('revoke', accountId, 'account_deleted', 5)).outcome).toBe(
      'already_applied'
    );
    expect(await operation('unblock', accountId, 'access_unblock', 6)).toEqual({
      outcome: 'refused',
      error: 'account_deleted',
    });
    expect(
      (await operation('end-device-sessions', accountId, 'apple_consent_revoked', 7)).outcome
    ).toBe('no_subject');
    expect(
      await importAccount(importRequest({ app_user_id: accountId, source_version: 9 }))
    ).toEqual({ outcome: 'refused', error: 'deleted' });
  });

  it('records a tombstone and its audit row for a subject UTS does not hold', async () => {
    const subject = `oauth/absent-${randomUUID()}`;
    const operationId = randomUUID();
    expect(
      await operation('revoke-api-credentials', subject, 'staff_api_reset', 2, operationId)
    ).toEqual({
      outcome: 'no_subject',
      feedEntries: [],
    });
    expect(
      await operation('revoke-api-credentials', subject, 'staff_api_reset', 2, operationId)
    ).toEqual({
      outcome: 'already_applied',
      feedEntries: [],
    });
    const tombstones = await owner.query(
      'SELECT operation::text, reason, source_version FROM uts.subject_tombstones WHERE subject = $1',
      [subject]
    );
    expect(tombstones.rows).toEqual([
      { operation: 'revoke_api_credentials', reason: 'staff_api_reset', source_version: 2n },
    ]);
    expect((await auditTypes(subject)).map(row => row.event_type)).toEqual([
      'ai.kilo.uts.subject.tombstoned',
    ]);
  });
});

describe('authority sync', () => {
  it('moves the primary email forward only, and refuses an address another account holds', async () => {
    const accountId = await insertAccount(owner);
    const other = await insertAccount(owner);
    const taken = (
      await owner.query<{ primary_email: string }>(
        'SELECT primary_email FROM uts.accounts WHERE id = $1',
        [other]
      )
    ).rows[0].primary_email;
    const sync = (email: string, version: number) =>
      subjects.syncPrimaryEmail({
        environment,
        workload,
        operationId: randomUUID(),
        actor: 'system:scim',
        sourceVersion: version,
        subject: accountId,
        primaryEmail: email,
      });
    expect((await sync('moved@example.com', 3)).outcome).toBe('applied');
    expect((await sync('older@example.com', 2)).outcome).toBe('already_applied');
    expect(await sync(taken, 4)).toEqual({ outcome: 'refused', error: 'email_taken' });
    const row = await owner.query('SELECT primary_email FROM uts.accounts WHERE id = $1', [
      accountId,
    ]);
    expect(row.rows).toEqual([{ primary_email: 'moved@example.com' }]);
    const audit = await owner.query<{ text: string }>(
      'SELECT event::text AS text FROM uts.audit_events WHERE account_id = $1',
      [accountId]
    );
    expect(audit.rows.some(item => item.text.includes('moved@example.com'))).toBe(false);
  });

  it('adds, changes and removes a membership by version; a removal revokes org-bound PATs', async () => {
    const accountId = await insertAccount(owner);
    const orgId = randomUUID();
    const sync = (role: 'member' | 'admin' | null, version: number) =>
      subjects.syncMembership({
        environment,
        workload,
        operationId: randomUUID(),
        actor: 'admin:owner-1',
        sourceVersion: version,
        subject: accountId,
        orgId,
        role,
      });
    expect((await sync('member', 1)).outcome).toBe('applied');
    expect((await sync('admin', 1)).outcome).toBe('already_applied');
    expect((await sync('admin', 2)).outcome).toBe('applied');
    await owner.query(
      `INSERT INTO uts.personal_access_tokens (account_id, name, token_hash, last_four, audience,
         scope, org_id, gate_pass_id, expires_at)
       VALUES ($1, 'org', $2, 'efgh', 'uts', 'uts:probe.read', $3, $4, now() + interval '30 days')`,
      [accountId, randomBytes(32), orgId, await insertGatePass(owner, accountId, 'pat_create')]
    );
    const removed = await sync(null, 3);
    if (removed.outcome !== 'applied') throw new Error(`removal answered ${removed.outcome}`);
    expect(kindsOf(removed.feedEntries)).toEqual(['pat']);
    expect((await sync('member', 2)).outcome).toBe('already_applied');
    const membership = await owner.query(
      'SELECT status::text, role::text FROM uts.org_memberships WHERE org_id = $1 AND account_id = $2',
      [orgId, accountId]
    );
    expect(membership.rows).toEqual([{ status: 'removed', role: 'admin' }]);
  });

  it('maps a WorkOS connection to the app organization only while every link holds', async () => {
    const accountId = await insertAccount(owner);
    const orgId = randomUUID();
    const workosOrg = `org_${randomUUID()}`;
    const [first, second] = [`conn_${randomUUID()}`, `conn_${randomUUID()}`];
    const check = identityStoreSsoAuthority(new IdentityStore(app));
    const verify = (connection: string, organization = workosOrg) =>
      check({
        subject: accountId,
        workosConnectionId: connection,
        workosOrganizationId: organization,
      });
    expect((await syncSso(orgId, workosOrg, [first, second], 5)).outcome).toBe('applied');
    expect((await syncSso(orgId, workosOrg, [first, second], 5)).outcome).toBe('already_applied');
    expect(await verify(first)).toEqual({ status: 'unverified' });
    await subjects.syncMembership({
      environment,
      workload,
      operationId: randomUUID(),
      actor: 'system:scim',
      sourceVersion: 1,
      subject: accountId,
      orgId,
      role: 'member',
    });
    expect(await verify(first)).toEqual({ status: 'verified', appOrganizationId: orgId });
    expect(await verify(first, 'org_other')).toEqual({ status: 'unverified' });
    expect((await syncSso(orgId, workosOrg, [second], 4)).outcome).toBe('already_applied');
    expect((await syncSso(orgId, workosOrg, [second], 6)).outcome).toBe('applied');
    expect(await verify(first)).toEqual({ status: 'unverified' });
    expect(await verify(second)).toEqual({ status: 'verified', appOrganizationId: orgId });
    const policy = await owner.query(
      'SELECT enforcement::text, event_version FROM uts.org_sso_policies WHERE org_id = $1',
      [orgId]
    );
    expect(policy.rows).toEqual([{ enforcement: 'required', event_version: 6n }]);
    await operation('revoke', accountId, 'access_block', 2);
    expect(await verify(second)).toEqual({ status: 'unverified' });
  });
});

describe('round-1 review fixes', () => {
  const email = (subject: string, address: string, version: number) =>
    subjects.syncPrimaryEmail({
      environment,
      workload,
      operationId: randomUUID(),
      actor: 'system:scim',
      sourceVersion: version,
      subject,
      primaryEmail: address,
    });

  it('orders status and email by their own versions; revocations raise neither', async () => {
    const ended = await insertAccount(owner);
    expect((await operation('end-browser-sessions', ended, 'staff_signout', 6)).outcome).toBe(
      'already_applied'
    );
    expect((await operation('revoke', ended, 'access_block', 5)).outcome).toBe('applied');
    expect(await accountRow(ended)).toMatchObject({ status: 'blocked', status_version: 5n });

    const recovered = await insertAccount(owner);
    expect((await operation('revoke', recovered, 'account_recovery', 6)).outcome).toBe('applied');
    const address = `${randomBytes(5).toString('hex')}@example.com`;
    expect((await email(recovered, address, 5)).outcome).toBe('applied');
    expect(await accountRow(recovered)).toMatchObject({ status_version: 0n, email_version: 5n });

    const emailed = await insertAccount(owner);
    expect((await email(emailed, `${randomBytes(5).toString('hex')}@example.com`, 6)).outcome).toBe(
      'applied'
    );
    expect((await operation('revoke', emailed, 'access_block', 5)).outcome).toBe('applied');
    expect(await accountRow(emailed)).toMatchObject({
      status: 'blocked',
      status_version: 5n,
      email_version: 6n,
    });
  });

  it("refuses a session issued before the account's revoked_before after the feed row expired", async () => {
    const accountId = await insertAccount(owner);
    const issuedBefore = new Date(Date.now() - 60_000);
    await operation('revoke', accountId, 'account_reset', 1);
    await owner.query("DELETE FROM uts.revocations WHERE kind = 'subject' AND subject_id = $1", [
      accountId,
    ]);
    const check = async (issuedAt: Date) =>
      (
        await owner.query<{ revoked: boolean }>(
          'SELECT uts.subject_revoked_since($1, $2) AS revoked',
          [accountId, issuedAt]
        )
      ).rows[0].revoked;
    expect(await check(issuedBefore)).toBe(true);
    expect(await check(new Date(Date.now() + 60_000))).toBe(false);
  });

  it('refuses a WorkOS identity outside the SSO tie, without one, or on an inactive connection', async () => {
    const orgId = randomUUID();
    const otherOrg = randomUUID();
    const workosOrg = `org_${randomUUID()}`;
    const [own, foreign, retired] = [randomUUID(), randomUUID(), randomUUID()].map(
      id => `conn_${id}`
    );
    await syncSso(orgId, workosOrg, [own, retired], 1);
    await syncSso(orgId, workosOrg, [own], 2);
    await syncSso(otherOrg, `org_${randomUUID()}`, [foreign], 1);
    const workos = (connection: string) => ({
      provider: 'workos' as const,
      provider_subject: `prof_${randomUUID()}`,
      verified_email: null,
      workos_connection_id: connection,
      linked_at: '2025-01-01T00:00:00Z',
    });
    const tie = (connection: string) => ({
      app_organization_id: orgId,
      workos_organization_id: workosOrg,
      workos_connection_id: connection,
      role: 'member' as const,
    });
    const refused = { outcome: 'refused', error: 'sso_authority_mismatch' };
    expect(await importAccount(importRequest({ verified_identities: [workos(own)] }))).toEqual(
      refused
    );
    expect(
      await importAccount(
        importRequest({ verified_identities: [workos(foreign)], sso_authority: tie(own) })
      )
    ).toEqual(refused);
    expect(
      await importAccount(
        importRequest({ verified_identities: [workos(retired)], sso_authority: tie(own) })
      )
    ).toEqual(refused);
    expect(await importAccount(importRequest({ sso_authority: tie(retired) }))).toEqual(refused);
    expect(
      await importAccount(
        importRequest({ verified_identities: [workos(own)], sso_authority: tie(own) })
      )
    ).toEqual({ outcome: 'imported' });
  });

  it('never moves a connection that is active in another organization', async () => {
    const connection = `conn_${randomUUID()}`;
    const [first, second] = [randomUUID(), randomUUID()];
    expect((await syncSso(first, 'org_x', [connection], 1)).outcome).toBe('applied');
    expect(await syncSso(second, 'org_y', [connection], 1)).toEqual({
      outcome: 'refused',
      error: 'connection_conflict',
    });
    expect((await syncSso(first, 'org_x', [], 2)).outcome).toBe('applied');
    expect((await syncSso(second, 'org_y', [connection], 2)).outcome).toBe('applied');
    const row = await owner.query(
      'SELECT org_id FROM uts.sso_connections WHERE workos_connection_id = $1',
      [connection]
    );
    expect(row.rows).toEqual([{ org_id: second }]);
  });

  it('keeps a revoked CI trust policy and an ended sandbox grant final', async () => {
    const accountId = await insertAccount(owner);
    await owner.query(
      `INSERT INTO uts.sandbox_grants (account_id, sandbox_session_id, allowed_scopes, expires_at, status, ended_at)
       VALUES ($1, $2, '{uts:probe.read}', now() + interval '1 hour', 'ended', now())`,
      [accountId, randomUUID()]
    );
    await owner.query(
      `INSERT INTO uts.ci_trust_policies (account_id, gate_pass_id, repository, repository_id,
         audience, scopes, status, revoked_at)
       VALUES ($1, $2, 'kilo/e2e', 1, 'uts', '{uts:probe.read}', 'revoked', now())`,
      [accountId, await insertGatePass(owner, accountId, 'ci_policy_create')]
    );
    for (const table of ['sandbox_grants', 'ci_trust_policies']) {
      expect(
        await sqlStateOf(() =>
          owner.query(`UPDATE uts.${table} SET status = 'active' WHERE account_id = $1`, [
            accountId,
          ])
        )
      ).toBe('23514');
    }
  });
});

describe('the user-created event', () => {
  it('is written with every uts_ account, read oldest first, and leaves on acknowledgement', async () => {
    const id = `uts_${Array.from(randomBytes(26), byte => 'abcdefghijklmnopqrstuvwxyz234567'[byte % 32]).join('')}`;
    await app.query("INSERT INTO uts.accounts (id, primary_email) VALUES ($1, 'new@example.com')", [
      id,
    ]);
    const events = await subjects.readAppEvents(100);
    const event = events.find(item => item.account.id === id);
    expect(event).toMatchObject({
      type: 'user.created',
      account: { id, primary_email: 'new@example.com' },
    });
    expect(await subjects.ackAppEvents([event?.event_id ?? randomUUID(), randomUUID()])).toBe(1);
    expect((await subjects.readAppEvents(100)).some(item => item.account.id === id)).toBe(false);
    expect(await sqlStateOf(() => app.query('SELECT 1 FROM uts.app_account_events LIMIT 1'))).toBe(
      '42501'
    );
  });

  it('leaves with an account deleted before the app read it', async () => {
    const id = `uts_${'b'.repeat(26)}`;
    await app.query(
      "INSERT INTO uts.accounts (id, primary_email) VALUES ($1, 'gone@example.com')",
      [id]
    );
    await operation('revoke', id, 'account_deleted', 0);
    expect((await subjects.readAppEvents(100)).some(item => item.account.id === id)).toBe(false);
  });
});
