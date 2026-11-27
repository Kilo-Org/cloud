import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  KILO_API_HOME_WIDGET_SCOPE,
  UTS_HOME_WIDGET_GRANTS_PER_HOUR,
} from '@kilocode/uts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IdentityStore } from '../../src/db/client';
import {
  type GrantStore,
  type HomeWidgetExchangeInput,
  type ProofBinding,
  identityStoreGrants,
} from '../../src/grants/store';
import { type SubjectStore, identityStoreSubjects } from '../../src/subjects/store';
import { TestDatabase, insertAccount, insertDeviceSession, sqlStateOf } from './harness';

/**
 * The home-widget exchange (migration 0024) through the Worker's own statement
 * (`src/grants/store.ts`), run as the app login against the migrated schema. The app grant a test
 * starts from is inserted as the owner, as a `kilo-mobile` code exchange would have stored it.
 */

let db: TestDatabase;
let owner: pg.Client;
let app: pg.Client;
let grants: GrantStore;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  app = await db.connect('uts_app_a');
  grants = identityStoreGrants(new IdentityStore(app));
});
afterAll(() => db.drop());

const environment = 'development';
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const refreshToken = () => `kilo_rt_${randomBytes(48).toString('base64url')}`;
const proofOf = (jkt: Buffer): ProofBinding => ({ jkt, jti: randomUUID() });
const MOBILE_SCOPES = [KILO_API_HOME_WIDGET_SCOPE, 'notifications:badges.read'];

type AppGrant = {
  accountId: string;
  sessionId: string;
  grantId: string;
  token: string;
  jkt: Buffer;
};

/** A live `kilo-mobile` grant of a new account, or of `accountId`. */
async function appGrant(
  options: { accountId?: string; orgId?: string | null; scopes?: string[]; clientId?: string } = {}
): Promise<AppGrant> {
  const accountId = options.accountId ?? (await insertAccount(owner));
  const sessionId = await insertDeviceSession(owner, accountId, 'mobile');
  const grantId = randomUUID();
  const token = refreshToken();
  const jkt = randomBytes(32);
  await owner.query(
    `INSERT INTO uts.refresh_grants (
       id, account_id, device_session_id, client_id, client_class, token_hash, dpop_jkt,
       allowed_scopes, org_id, idle_expires_at, expires_at
     ) VALUES ($1, $2, $3, $4, 'mobile', $5, $6, $7, $8, now() + interval '60 days',
       now() + interval '365 days')`,
    [
      grantId,
      accountId,
      sessionId,
      options.clientId ?? 'kilo-mobile',
      sha256(token),
      jkt,
      options.scopes ?? MOBILE_SCOPES,
      options.orgId ?? null,
    ]
  );
  return { accountId, sessionId, grantId, token, jkt };
}

/** A widget exchange of `parent`, with a fresh proof of its key and a new widget grant. */
function widgetExchange(parent: AppGrant, overrides: Partial<HomeWidgetExchangeInput> = {}) {
  const token = refreshToken();
  const input: HomeWidgetExchangeInput = {
    environment,
    parentTokenHash: sha256(parent.token),
    parentGrantId: parent.grantId,
    clientId: 'kilo-mobile',
    proof: proofOf(parent.jkt),
    widgetGrantId: randomUUID(),
    widgetTokenHash: sha256(token),
    scope: KILO_API_HOME_WIDGET_SCOPE,
    orgId: null,
    ...overrides,
  };
  return { input, token, grantId: input.widgetGrantId };
}

async function issuedWidget(parent: AppGrant, overrides: Partial<HomeWidgetExchangeInput> = {}) {
  const exchange = widgetExchange(parent, overrides);
  const result = await grants.exchangeHomeWidget(exchange.input);
  if (result.outcome !== 'issued') throw new Error(`exchange answered ${result.outcome}`);
  return { ...exchange, result };
}

const GrantRowSchema = z.object({
  status: z.enum(['active', 'revoked']),
  revoke_reason: z.string().nullable(),
  parent_grant_id: z.string().nullable(),
  device_session_id: z.string(),
  client_id: z.string(),
  client_class: z.string(),
  dpop_jkt: z.instanceof(Buffer),
  allowed_scopes: z.array(z.string()),
  org_id: z.string().nullable(),
  audit_environment: z.string().nullable(),
  expires_at: z.date(),
  idle_expires_at: z.date(),
});

async function grantRow(id: string) {
  const result = await owner.query(
    `SELECT status, revoke_reason, parent_grant_id, device_session_id, client_id, client_class,
       dpop_jkt, allowed_scopes::text[] AS allowed_scopes, org_id, audit_environment, expires_at,
       idle_expires_at
     FROM uts.refresh_grants WHERE id = $1`,
    [id]
  );
  return GrantRowSchema.parse(result.rows[0]);
}

async function sessionStatus(id: string): Promise<string> {
  const result = await owner.query<{ status: string }>(
    'SELECT status FROM uts.device_sessions WHERE id = $1',
    [id]
  );
  return result.rows[0].status;
}

async function auditTypes(accountId: string) {
  const result = await owner.query<{ event_type: string; attributes: Record<string, unknown> }>(
    `SELECT event_type, event #> '{data,attributes}' AS attributes
     FROM uts.audit_events WHERE account_id = $1 ORDER BY id`,
    [accountId]
  );
  return result.rows;
}

async function member(accountId: string, orgId: string) {
  await owner.query(
    `INSERT INTO uts.org_memberships (org_id, account_id, role, event_version) VALUES ($1, $2, 'member', 1)`,
    [orgId, accountId]
  );
}

const refresh = (grantId: string, token: string, jkt: Buffer, scopes: string[] | null = null) =>
  grants.refreshFirstParty({
    environment,
    tokenHash: sha256(token),
    grantId,
    clientId: 'kilo-mobile',
    proof: proofOf(jkt),
    scopes,
    resources: null,
  });

describe('the home-widget exchange', () => {
  it('stores a widget grant of the same session and key that holds only the widget scope', async () => {
    const parent = await appGrant();
    const signIns = async () =>
      (
        await owner.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM uts.sign_ins WHERE account_id = $1',
          [parent.accountId]
        )
      ).rows[0].count;
    const before = await signIns();

    const widget = await issuedWidget(parent);

    expect(widget.result).toMatchObject({
      subjectId: parent.accountId,
      orgId: null,
      orgRole: null,
      amr: ['passkey'],
      scopes: [KILO_API_HOME_WIDGET_SCOPE],
      feedEntries: [],
    });
    expect(widget.result.tokenIds).toHaveLength(1);
    const parentRow = await grantRow(parent.grantId);
    const row = await grantRow(widget.grantId);
    expect(row).toMatchObject({
      status: 'active',
      parent_grant_id: parent.grantId,
      audit_environment: 'development',
      device_session_id: parent.sessionId,
      client_id: 'kilo-mobile',
      client_class: 'mobile',
      allowed_scopes: [KILO_API_HOME_WIDGET_SCOPE],
      org_id: null,
    });
    expect(row.dpop_jkt).toEqual(parent.jkt);
    expect(row.expires_at).toEqual(parentRow.idle_expires_at);
    expect(widget.result.refreshExpiresAt).toEqual(parentRow.idle_expires_at);
    expect(await signIns()).toBe(before);
    const created = (await auditTypes(parent.accountId)).find(
      event => event.event_type === 'ai.kilo.uts.grant.created'
    );
    expect(created?.attributes).toMatchObject({
      grantType: 'token_exchange',
      grantId: widget.grantId,
      parentGrantId: parent.grantId,
      scopes: [KILO_API_HOME_WIDGET_SCOPE],
    });
  });

  it('lets the widget refresh with its own token and key, for the widget scope only', async () => {
    const parent = await appGrant();
    const widget = await issuedWidget(parent);
    expect(await refresh(widget.grantId, widget.token, parent.jkt)).toMatchObject({
      outcome: 'issued',
      scopes: [KILO_API_HOME_WIDGET_SCOPE],
    });
    expect(
      await refresh(widget.grantId, widget.token, parent.jkt, ['notifications:badges.read'])
    ).toEqual({ outcome: 'invalid_scope' });
    expect(await refresh(widget.grantId, widget.token, randomBytes(32))).toEqual({
      outcome: 'dpop_mismatch',
    });
  });

  it('replaces the previous widget grant of the app grant, with its feed entry', async () => {
    const parent = await appGrant();
    const first = await issuedWidget(parent);
    const second = await issuedWidget(parent);

    expect(second.result.feedEntries).toEqual([
      expect.objectContaining({ kind: 'grant', id: first.grantId, revokedBefore: null }),
    ]);
    expect(await grantRow(first.grantId)).toMatchObject({
      status: 'revoked',
      revoke_reason: 'replaced',
    });
    expect((await grantRow(second.grantId)).status).toBe('active');
    expect(await refresh(first.grantId, first.token, parent.jkt)).toEqual({
      outcome: 'invalid_grant',
    });
    const revoked = (await auditTypes(parent.accountId)).find(
      event => event.event_type === 'ai.kilo.uts.grant.revoked'
    );
    expect(revoked?.attributes).toMatchObject({ grantId: first.grantId, reason: 'replaced' });
    expect(await sessionStatus(parent.sessionId)).toBe('active');
  });

  it('ends only the widget when the widget grant is revoked', async () => {
    const parent = await appGrant();
    const widget = await issuedWidget(parent);
    const revoked = await grants.revoke({
      environment,
      tokenHash: sha256(widget.token),
      clientId: 'kilo-mobile',
    });
    expect(revoked).toEqual({
      outcome: 'revoked',
      feedEntries: [expect.objectContaining({ kind: 'grant', id: widget.grantId })],
    });
    expect((await grantRow(parent.grantId)).status).toBe('active');
    expect(await sessionStatus(parent.sessionId)).toBe('active');
    expect(await refresh(widget.grantId, widget.token, parent.jkt)).toEqual({
      outcome: 'invalid_grant',
    });
    expect(await refresh(parent.grantId, parent.token, parent.jkt)).toMatchObject({
      outcome: 'issued',
    });
  });

  it('ends the widget with the app grant, each with its feed entry, and then the session', async () => {
    const parent = await appGrant();
    const widget = await issuedWidget(parent);
    const revoked = await grants.revoke({
      environment,
      tokenHash: sha256(parent.token),
      clientId: 'kilo-mobile',
    });
    expect(revoked.outcome).toBe('revoked');
    expect(revoked.feedEntries.map(entry => entry.id).sort()).toEqual(
      [parent.grantId, widget.grantId].sort()
    );
    expect(await grantRow(widget.grantId)).toMatchObject({
      status: 'revoked',
      revoke_reason: 'sign_out',
    });
    expect(await sessionStatus(parent.sessionId)).toBe('revoked');
    const widgetAudit = await owner.query<{ actor: unknown; attributes: unknown; source: string }>(
      `SELECT event #> '{data,actor}' AS actor, event #> '{data,attributes}' AS attributes,
         event ->> 'source' AS source
       FROM uts.audit_events
       WHERE account_id = $1 AND event_type = 'ai.kilo.uts.grant.revoked'
         AND event #>> '{data,attributes,grantId}' = $2`,
      [parent.accountId, widget.grantId]
    );
    expect(widgetAudit.rows).toEqual([
      {
        actor: expect.objectContaining({ kind: 'system' }),
        attributes: expect.objectContaining({ parentGrantId: parent.grantId, reason: 'sign_out' }),
        source: 'kilo:uts:development',
      },
    ]);
    // A retry of the sign-out publishes both entries again.
    const retry = await grants.revoke({
      environment,
      tokenHash: sha256(parent.token),
      clientId: 'kilo-mobile',
    });
    expect(retry.outcome).toBe('already_revoked');
    expect(retry.feedEntries.map(entry => entry.id).sort()).toEqual(
      [parent.grantId, widget.grantId].sort()
    );
  });

  it('makes an end of the widget grant lock its app grant before it touches the widget', async () => {
    const parent = await appGrant();
    const widget = await issuedWidget(parent);
    const holder = await db.connectAsOwner();
    const ender = await db.connectAsOwner();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM uts.refresh_grants WHERE id = $1 FOR NO KEY UPDATE', [
      parent.grantId,
    ]);
    const ending = ender.query(
      `SELECT uts.end_grant('first_party', $1, 'user_revoke') AS account`,
      [widget.grantId]
    );
    await sleep(200);
    // The waiting end holds no lock on the widget row: it waits on the app grant first, so an
    // exchange holding the app grant can still end the widget, and no cycle forms.
    await owner.query('BEGIN');
    expect(
      (
        await owner.query(
          'SELECT status FROM uts.refresh_grants WHERE id = $1 FOR NO KEY UPDATE NOWAIT',
          [widget.grantId]
        )
      ).rows
    ).toEqual([{ status: 'active' }]);
    await owner.query('ROLLBACK');
    await holder.query('COMMIT');
    expect((await ending).rows).toEqual([{ account: parent.accountId }]);
    expect((await grantRow(widget.grantId)).status).toBe('revoked');
    expect((await grantRow(parent.grantId)).status).toBe('active');
    await holder.end();
    await ender.end();
  });

  /**
   * An exchange held at its app-grant lock (by `holder`) after it took the account and membership
   * locks, and `revoking`, a statement on another app connection that starts meanwhile. Releasing
   * the holder must let both finish, the revoking one last, with no deadlock (40P01).
   */
  async function exchangeThenRevoke(
    parent: AppGrant,
    exchangeOverrides: Partial<HomeWidgetExchangeInput>,
    revoking: (subjects: SubjectStore) => Promise<{ outcome: string }>
  ) {
    const holder = await db.connectAsOwner();
    const other = await db.connect('uts_app_a');
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM uts.refresh_grants WHERE id = $1 FOR NO KEY UPDATE', [
      parent.grantId,
    ]);
    const exchange = widgetExchange(parent, exchangeOverrides);
    const exchanged = grants.exchangeHomeWidget(exchange.input);
    await sleep(200);
    let revokeSettled = false;
    const revoked = revoking(identityStoreSubjects(new IdentityStore(other))).finally(() => {
      revokeSettled = true;
    });
    await sleep(200);
    expect(revokeSettled).toBe(false);
    await holder.query('COMMIT');
    const [exchangeResult, revokeResult] = await Promise.all([exchanged, revoked]);
    await holder.end();
    await other.end();
    return { exchange, exchangeResult, revokeResult };
  }

  it('lets a membership removal that arrives during an exchange wait for it, then revoke the new widget', async () => {
    const parent = await appGrant();
    const orgId = randomUUID();
    await member(parent.accountId, orgId);
    const old = await issuedWidget(parent, { orgId });
    const { exchange, exchangeResult, revokeResult } = await exchangeThenRevoke(
      parent,
      { orgId },
      subjects =>
        subjects.syncMembership({
          environment,
          workload: 'web',
          operationId: randomUUID(),
          actor: 'system:scim',
          sourceVersion: 2,
          subject: parent.accountId,
          orgId,
          role: null,
        })
    );
    expect(exchangeResult.outcome).toBe('issued');
    expect(revokeResult.outcome).toBe('applied');
    expect(await grantRow(exchange.grantId)).toMatchObject({
      status: 'revoked',
      revoke_reason: 'member_removed',
    });
    expect(await grantRow(old.grantId)).toMatchObject({
      status: 'revoked',
      revoke_reason: 'replaced',
    });
    expect((await grantRow(parent.grantId)).status).toBe('active');
  });

  it('lets a subject operation that arrives during an exchange wait for it, then revoke the new widget', async () => {
    const parent = await appGrant();
    await issuedWidget(parent);
    const { exchange, exchangeResult, revokeResult } = await exchangeThenRevoke(
      parent,
      {},
      subjects =>
        subjects.applyOperation({
          environment,
          workload: 'web',
          operation: 'end-device-sessions',
          operationId: randomUUID(),
          subject: parent.accountId,
          reason: 'apple_consent_revoked',
          actor: 'admin:staff-1',
          sourceVersion: 1,
        })
    );
    expect(exchangeResult.outcome).toBe('issued');
    expect(revokeResult.outcome).toBe('applied');
    expect((await grantRow(exchange.grantId)).status).toBe('revoked');
    expect((await grantRow(parent.grantId)).status).toBe('revoked');
    expect(await sessionStatus(parent.sessionId)).toBe('revoked');
  });

  it('makes a revoke of the app grant wait for an exchange in flight, and refuses it after', async () => {
    const parent = await appGrant();
    const holder = await db.connectAsOwner();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM uts.refresh_grants WHERE id = $1 FOR NO KEY UPDATE', [
      parent.grantId,
    ]);
    const exchange = widgetExchange(parent);
    const pending = grants.exchangeHomeWidget(exchange.input);
    await sleep(200);
    await holder.query(`SELECT uts.end_grant('first_party', $1, 'sign_out')`, [parent.grantId]);
    await holder.query('COMMIT');
    expect(await pending).toEqual({ outcome: 'invalid_grant' });
    const stored = await owner.query('SELECT 1 FROM uts.refresh_grants WHERE id = $1', [
      exchange.grantId,
    ]);
    expect(stored.rowCount).toBe(0);
  });

  it('refuses a mismatched key, a replayed proof, a missing scope, a widget subject and another client', async () => {
    const parent = await appGrant();
    expect(
      await grants.exchangeHomeWidget(
        widgetExchange(parent, { proof: proofOf(randomBytes(32)) }).input
      )
    ).toEqual({ outcome: 'dpop_mismatch' });
    const proof = proofOf(parent.jkt);
    expect((await grants.exchangeHomeWidget(widgetExchange(parent, { proof }).input)).outcome).toBe(
      'issued'
    );
    expect(await grants.exchangeHomeWidget(widgetExchange(parent, { proof }).input)).toEqual({
      outcome: 'dpop_replay',
    });
    expect(
      await grants.exchangeHomeWidget(
        widgetExchange(parent, { scope: 'notifications:badges.read' }).input
      )
    ).toEqual({ outcome: 'invalid_scope' });
    const withoutScope = await appGrant({ scopes: ['notifications:badges.read'] });
    expect(await grants.exchangeHomeWidget(widgetExchange(withoutScope).input)).toEqual({
      outcome: 'invalid_scope',
    });
    expect(
      await grants.exchangeHomeWidget(widgetExchange(parent, { parentGrantId: randomUUID() }).input)
    ).toEqual({ outcome: 'invalid_grant' });
    const widget = await issuedWidget(parent);
    const asSubject: AppGrant = { ...parent, grantId: widget.grantId, token: widget.token };
    expect(await grants.exchangeHomeWidget(widgetExchange(asSubject).input)).toEqual({
      outcome: 'invalid_grant',
    });
    const cli = await appGrant({ clientId: 'kilo-cli' });
    expect(
      await grants.exchangeHomeWidget(widgetExchange(cli, { clientId: 'kilo-cli' }).input)
    ).toEqual({ outcome: 'invalid_grant' });
  });

  it(`creates at most ${UTS_HOME_WIDGET_GRANTS_PER_HOUR} widget grants per app grant in an hour`, async () => {
    const parent = await appGrant();
    for (let index = 0; index < UTS_HOME_WIDGET_GRANTS_PER_HOUR; index += 1) {
      await issuedWidget(parent);
    }
    const limited = await grants.exchangeHomeWidget(widgetExchange(parent).input);
    if (limited.outcome !== 'rate_limited') throw new Error(`answered ${limited.outcome}`);
    expect(limited.retryAfterSeconds).toBeGreaterThan(3500);
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(3600);
    const live = await owner.query(
      `SELECT count(*)::int AS count FROM uts.refresh_grants
       WHERE parent_grant_id = $1 AND status = 'active'`,
      [parent.grantId]
    );
    expect(live.rows[0]).toEqual({ count: 1 });
  });

  it('refuses a ticket from a widget grant, which the app grant still mints', async () => {
    const parent = await appGrant();
    const widget = await issuedWidget(parent);
    const ticket = (grantId: string, token: string) =>
      app.query<{ outcome: string }>(
        `SELECT outcome FROM uts.issue_ticket($1, $2, $3, 'kilo-mobile', $4, $5, $6, 'stream', 'kilo-api', NULL)`,
        [environment, sha256(token), grantId, parent.jkt, randomUUID(), randomBytes(32)]
      );
    expect((await ticket(widget.grantId, widget.token)).rows[0].outcome).toBe('invalid_grant');
    expect((await ticket(parent.grantId, parent.token)).rows[0].outcome).toBe('issued');
  });

  it('keeps every stored widget grant to the widget scope on a mobile grant', async () => {
    const parent = await appGrant();
    const insert = (
      scopes: string[],
      clientClass: 'desktop' | 'mobile',
      environmentName: string | null = 'development'
    ) =>
      owner.query(
        `INSERT INTO uts.refresh_grants (
           account_id, device_session_id, client_id, client_class, token_hash, dpop_jkt,
           allowed_scopes, idle_expires_at, expires_at, parent_grant_id, audit_environment
         ) VALUES ($1, $2, 'kilo-mobile', $3, $4, $5, $6, now() + interval '1 day',
           now() + interval '1 day', $7, $8)`,
        [
          parent.accountId,
          parent.sessionId,
          clientClass,
          sha256(refreshToken()),
          parent.jkt,
          scopes,
          parent.grantId,
          environmentName,
        ]
      );
    expect(await sqlStateOf(() => insert(MOBILE_SCOPES, 'mobile'))).toBe('23514');
    expect(await sqlStateOf(() => insert([KILO_API_HOME_WIDGET_SCOPE], 'desktop'))).toBe('23514');
    expect(await sqlStateOf(() => insert([KILO_API_HOME_WIDGET_SCOPE], 'mobile', null))).toBe(
      '23514'
    );
  });
});

describe('the home-widget exchange in an organization', () => {
  it('binds a personal app grant to an organization the account is a member of', async () => {
    const parent = await appGrant();
    const orgId = randomUUID();
    await member(parent.accountId, orgId);
    const widget = await issuedWidget(parent, { orgId });
    expect(widget.result).toMatchObject({ orgId, orgRole: 'member' });
    expect((await grantRow(widget.grantId)).org_id).toBe(orgId);
    expect((await grantRow(parent.grantId)).org_id).toBeNull();
  });

  it('refuses an organization without a membership, or whose SSO requirement the sign-in misses', async () => {
    const parent = await appGrant();
    expect(
      await grants.exchangeHomeWidget(widgetExchange(parent, { orgId: randomUUID() }).input)
    ).toEqual({ outcome: 'org_denied' });
    const ssoOrg = randomUUID();
    await member(parent.accountId, ssoOrg);
    await owner.query(
      `INSERT INTO uts.org_sso_policies (org_id, enforcement, event_version) VALUES ($1, 'required', 1)`,
      [ssoOrg]
    );
    expect(
      await grants.exchangeHomeWidget(widgetExchange(parent, { orgId: ssoOrg }).input)
    ).toEqual({ outcome: 'org_denied' });
  });

  it("keeps an org-bound app grant's widget in that organization only", async () => {
    const accountId = await insertAccount(owner);
    const orgId = randomUUID();
    await member(accountId, orgId);
    const parent = await appGrant({ accountId, orgId });
    expect((await issuedWidget(parent)).result.orgId).toBe(orgId);
    expect((await issuedWidget(parent, { orgId })).result.orgId).toBe(orgId);
    expect(
      await grants.exchangeHomeWidget(widgetExchange(parent, { orgId: randomUUID() }).input)
    ).toEqual({ outcome: 'org_denied' });
  });

  it('revokes the organization widget when the member is removed, and keeps the personal app grant', async () => {
    const parent = await appGrant();
    const orgId = randomUUID();
    await member(parent.accountId, orgId);
    const widget = await issuedWidget(parent, { orgId });
    const removed = await app.query<{ outcome: string; revoked_grants: number }>(
      'SELECT outcome, revoked_grants FROM uts.remove_org_member($1, $2, $3, 2)',
      [environment, orgId, parent.accountId]
    );
    expect(removed.rows[0]).toEqual({ outcome: 'removed', revoked_grants: 1 });
    expect(await grantRow(widget.grantId)).toMatchObject({
      status: 'revoked',
      revoke_reason: 'member_removed',
    });
    expect((await grantRow(parent.grantId)).status).toBe('active');
  });
});
