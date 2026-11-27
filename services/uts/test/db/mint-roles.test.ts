import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditEventSchema } from '@kilocode/sts-contracts';
import {
  UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
  UTS_SCOPE_REGISTRY,
  type UtsOrgRole,
  utsScopeEntry,
} from '@kilocode/uts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IdentityStore } from '../../src/db/client';
import { type GrantStore, identityStoreGrants } from '../../src/grants/store';
import { orgScopeRefusal } from '../../src/scopes/policy';
import { TestDatabase, insertAccount } from './harness';

/**
 * `accessTokenLifetimeSeconds` of `src/token/mint.ts` (which loads Worker-only modules), as the
 * decimal string an audit attribute array holds.
 */
const lifetimeOf = (scope: string) =>
  String(
    Math.min(
      UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
      utsScopeEntry(scope)?.maxLifetimeSeconds ?? UTS_ACCESS_TOKEN_LIFETIME_SECONDS
    )
  );

/**
 * The mint statements as migration 0005 replaces them: a scope limited to membership roles is
 * refused inside the statement before it writes anything when the caller holds another role; each
 * statement returns the caller's role in the bound organization, which the Worker checks again
 * before signing; and the audit row lists each token's own lifetime.
 */

let db: TestDatabase;
let owner: pg.Client;
let grants: GrantStore;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  grants = identityStoreGrants(new IdentityStore(await db.connect('uts_app_a')));
});
afterAll(() => db.drop());

const environment = 'development';
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const token = () => randomBytes(32).toString('base64url');
const device = {
  label: 'Kilo CLI',
  platform: 'linux',
  clientIp: null,
  asn: null,
  country: null,
  city: null,
};

async function member(role: UtsOrgRole) {
  const accountId = await insertAccount(owner);
  const orgId = randomUUID();
  await owner.query(
    `INSERT INTO uts.org_memberships (org_id, account_id, role, event_version) VALUES ($1, $2, $3, 1)`,
    [orgId, accountId, role]
  );
  return { accountId, orgId };
}

/**
 * A code for `scopes` in the organization. `exchange` turns it into a first-party grant; the
 * grant's `refresh` mints again with a fresh proof of the same key.
 */
async function codeFor(accountId: string, orgId: string | null, scopes: string[]) {
  const code = token();
  const verifier = token();
  const challenge = sha256(verifier).toString('base64url');
  const jkt = randomBytes(32);
  const issued = await grants.issueCode({
    environment,
    codeHash: sha256(code),
    client: { kind: 'first_party', clientId: 'kilo-cli', dpopJkt: jkt },
    accountId,
    browserSessionId: null,
    redirectUri: 'http://127.0.0.1:4100/callback',
    audiences: [...new Set(scopes.map(scope => scope.split(':')[0]))],
    scopes: [...scopes].sort(),
    orgId,
    codeChallenge: challenge,
    authTime: new Date(),
    amr: ['passkey'],
  });
  const exchange = async () => {
    const refreshToken = `kilo_rt_${token()}`;
    const grantId = randomUUID();
    const exchanged = await grants.exchangeCode({
      environment,
      codeHash: sha256(code),
      clientId: 'kilo-cli',
      redirectUri: 'http://127.0.0.1:4100/callback',
      codeChallenge: challenge,
      binding: {
        kind: 'first_party',
        proof: { jkt, jti: randomUUID() },
        clientClass: 'desktop',
        device,
      },
      grantId,
      refreshTokenHash: sha256(refreshToken),
      scopes: null,
      resources: null,
    });
    const refresh = () =>
      grants.refreshFirstParty({
        environment,
        tokenHash: sha256(refreshToken),
        grantId,
        clientId: 'kilo-cli',
        proof: { jkt, jti: randomUUID() },
        scopes: null,
        resources: null,
      });
    return { exchanged, refresh, grantId };
  };
  return { issued, exchange, codeHash: sha256(code) };
}

async function grantFor(accountId: string, orgId: string | null, scopes: string[]) {
  const { issued, exchange } = await codeFor(accountId, orgId, scopes);
  return { issued, ...(await exchange()) };
}

async function setRole(orgId: string, accountId: string, role: UtsOrgRole) {
  await owner.query(
    'UPDATE uts.org_memberships SET role = $3 WHERE org_id = $1 AND account_id = $2',
    [orgId, accountId, role]
  );
}

/** What the account has in the identity store: codes, sessions, grants and audit row types. */
async function stored(accountId: string) {
  const count = async (table: string) =>
    (
      await owner.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM uts.${table} WHERE account_id = $1`,
        [accountId]
      )
    ).rows[0].count;
  const audit = await owner.query<{ event_type: string }>(
    'SELECT event_type FROM uts.audit_events WHERE account_id = $1 ORDER BY id',
    [accountId]
  );
  return {
    codes: await count('authorization_codes'),
    sessions: await count('device_sessions'),
    grants: await count('refresh_grants'),
    audit: audit.rows.map(row => row.event_type),
  };
}

const AttributesSchema = z.object({
  tokenRefs: z.array(z.string()),
  scopes: z.array(z.string()),
  tokenLifetimeSeconds: z.array(z.string()),
});

async function mintAuditAttributes(accountId: string) {
  const rows = await owner.query<{ event_type: string; event: unknown }>(
    `SELECT event_type, event FROM uts.audit_events
     WHERE account_id = $1 AND event_type IN ('ai.kilo.uts.grant.created', 'ai.kilo.uts.token.issued')
     ORDER BY id`,
    [accountId]
  );
  return rows.rows.map(row =>
    AttributesSchema.parse(AuditEventSchema.parse(row.event).data.attributes)
  );
}

const ATTRIBUTION = 'ai-attribution:identity.read';

describe('the membership role at mint', () => {
  it.each(['owner', 'member'] as const)(
    'returns the role of an %s, and the role-limited scope passes',
    async role => {
      const { accountId, orgId } = await member(role);
      const { issued, exchanged, refresh } = await grantFor(accountId, orgId, [ATTRIBUTION]);
      expect(issued).toEqual({ outcome: 'issued', orgRole: role });
      expect(exchanged).toMatchObject({ outcome: 'issued', orgId, orgRole: role });
      const refreshed = await refresh();
      expect(refreshed).toMatchObject({ outcome: 'issued', orgId, orgRole: role });
      if (refreshed.outcome !== 'issued') throw new Error('refresh failed');
      expect(
        orgScopeRefusal(refreshed.scopes, refreshed.orgId, refreshed.orgRole, utsScopeEntry)
      ).toBeNull();
    }
  );

  it.each(['admin', 'billing_manager'] as const)(
    'refuses the role-limited scope to an %s at the code statement, storing nothing',
    async role => {
      const { accountId, orgId } = await member(role);
      const { issued } = await codeFor(accountId, orgId, [ATTRIBUTION]);
      expect(issued).toEqual({ outcome: 'invalid_scope' });
      expect(await stored(accountId)).toEqual({ codes: 0, sessions: 0, grants: 0, audit: [] });
    }
  );

  it('refuses the exchange when the role changed after the code, leaving no session or grant', async () => {
    const { accountId, orgId } = await member('member');
    const { issued, exchange, codeHash } = await codeFor(accountId, orgId, [ATTRIBUTION]);
    expect(issued).toEqual({ outcome: 'issued', orgRole: 'member' });
    await setRole(orgId, accountId, 'admin');
    const { exchanged } = await exchange();
    expect(exchanged).toEqual({ outcome: 'invalid_scope', feedEntries: [] });
    expect(await stored(accountId)).toEqual({
      codes: 1,
      sessions: 0,
      grants: 0,
      audit: ['ai.kilo.uts.authorization_code.issued'],
    });
    const code = await owner.query(
      'SELECT status FROM uts.authorization_codes WHERE code_hash = $1',
      [codeHash]
    );
    expect(code.rows).toEqual([{ status: 'issued' }]);
  });

  it('refuses a refresh once the member is demoted, without touching the grant or writing a row', async () => {
    const { accountId, orgId } = await member('member');
    const { refresh, grantId } = await grantFor(accountId, orgId, [ATTRIBUTION]);
    expect(await refresh()).toMatchObject({ outcome: 'issued', orgRole: 'member' });
    await setRole(orgId, accountId, 'admin');
    const grantBefore = await owner.query(
      'SELECT last_used_at, idle_expires_at, status FROM uts.refresh_grants WHERE id = $1',
      [grantId]
    );
    const auditBefore = (await stored(accountId)).audit;
    expect(await refresh()).toEqual({ outcome: 'invalid_scope' });
    const grantAfter = await owner.query(
      'SELECT last_used_at, idle_expires_at, status FROM uts.refresh_grants WHERE id = $1',
      [grantId]
    );
    expect(grantAfter.rows).toEqual(grantBefore.rows);
    expect((await stored(accountId)).audit).toEqual(auditBefore);
    // Back to member: the same grant mints again.
    await setRole(orgId, accountId, 'member');
    expect(await refresh()).toMatchObject({ outcome: 'issued', orgRole: 'member' });
  });

  it('returns no role without an organization', async () => {
    const accountId = await insertAccount(owner);
    const { issued, exchanged, refresh } = await grantFor(accountId, null, ['gateway:models.read']);
    expect(issued).toEqual({ outcome: 'issued', orgRole: null });
    expect(exchanged).toMatchObject({ outcome: 'issued', orgId: null, orgRole: null });
    expect(await refresh()).toMatchObject({ outcome: 'issued', orgId: null, orgRole: null });
  });

  it('agrees with the scope registry on the roles of every registered scope', async () => {
    const scopes = [...Object.keys(UTS_SCOPE_REGISTRY), 'gateway:unknown.read'];
    const result = await owner.query<{ scope: string; roles: string | null }>(
      'SELECT scope, uts.scope_org_roles(scope)::text AS roles FROM unnest($1::text[]) AS scope',
      [scopes]
    );
    const expected = (scope: string) => {
      const subjects = utsScopeEntry(scope)?.subjects;
      return subjects?.kind === 'org_member' && subjects.roles !== 'any'
        ? `{${subjects.roles.join(',')}}`
        : null;
    };
    expect(result.rows).toEqual(scopes.map(scope => ({ scope, roles: expected(scope) })));
  });
});

describe('token lifetimes in the audit row', () => {
  it('lists 300 seconds for a 5-minute scope and 600 for the others, in token order', async () => {
    const accountId = await insertAccount(owner);
    const scopes = ['gateway:models.read', 'user-data-export:exports.dispatch'];
    const { exchanged, refresh } = await grantFor(accountId, null, scopes);
    expect(exchanged.outcome).toBe('issued');
    expect((await refresh()).outcome).toBe('issued');
    const rows = await mintAuditAttributes(accountId);
    expect(rows).toHaveLength(2);
    for (const attributes of rows) {
      expect(attributes.tokenLifetimeSeconds).toEqual(
        attributes.scopes.map(scope => lifetimeOf(scope))
      );
      expect(attributes.tokenLifetimeSeconds).toHaveLength(attributes.tokenRefs.length);
      expect(
        attributes.tokenLifetimeSeconds[
          attributes.scopes.indexOf('user-data-export:exports.dispatch')
        ]
      ).toBe('300');
    }
  });

  it('agrees with the scope registry for every registered scope and an unknown one', async () => {
    const scopes = [...Object.keys(UTS_SCOPE_REGISTRY), 'gateway:unknown.read'];
    const result = await owner.query<{ lifetimes: unknown }>(
      'SELECT uts.token_lifetimes($1) AS lifetimes',
      [scopes]
    );
    expect(result.rows[0].lifetimes).toEqual(scopes.map(scope => lifetimeOf(scope)));
  });
});
