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
 * The mint statements as migration 0005 replaces them: each returns the caller's membership role
 * in the bound organization, which the Worker checks against the scope registry before signing,
 * and the audit row lists each token's own lifetime.
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

/** A code, then a first-party grant for `scopes` in the organization; returns both results. */
async function grantFor(accountId: string, orgId: string | null, scopes: string[]) {
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
  return { issued, exchanged, refresh, grantId };
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
      expect(orgScopeRefusal(refreshed.scopes, refreshed.orgId, refreshed.orgRole)).toBeNull();
    }
  );

  it.each(['admin', 'billing_manager'] as const)(
    'returns the role of an %s, which the role-limited scope refuses',
    async role => {
      const { accountId, orgId } = await member(role);
      const { issued, exchanged, refresh } = await grantFor(accountId, orgId, [ATTRIBUTION]);
      expect(issued).toEqual({ outcome: 'issued', orgRole: role });
      if (exchanged.outcome !== 'issued') throw new Error('exchange failed');
      expect(exchanged.orgRole).toBe(role);
      expect(orgScopeRefusal(exchanged.scopes, exchanged.orgId, exchanged.orgRole)).toBe(
        ATTRIBUTION
      );
      const refreshed = await refresh();
      if (refreshed.outcome !== 'issued') throw new Error('refresh failed');
      expect(orgScopeRefusal(refreshed.scopes, refreshed.orgId, refreshed.orgRole)).toBe(
        ATTRIBUTION
      );
    }
  );

  it('reads the role again at each refresh, so a demoted member loses the scope', async () => {
    const { accountId, orgId } = await member('member');
    const { refresh } = await grantFor(accountId, orgId, [ATTRIBUTION]);
    const before = await refresh();
    expect(before).toMatchObject({ outcome: 'issued', orgRole: 'member' });
    await owner.query(
      `UPDATE uts.org_memberships SET role = 'admin' WHERE org_id = $1 AND account_id = $2`,
      [orgId, accountId]
    );
    const after = await refresh();
    if (after.outcome !== 'issued') throw new Error('refresh failed');
    expect(after.orgRole).toBe('admin');
    expect(orgScopeRefusal(after.scopes, after.orgId, after.orgRole)).toBe(ATTRIBUTION);
  });

  it('returns no role without an organization', async () => {
    const accountId = await insertAccount(owner);
    const { issued, exchanged, refresh } = await grantFor(accountId, null, ['gateway:models.read']);
    expect(issued).toEqual({ outcome: 'issued', orgRole: null });
    expect(exchanged).toMatchObject({ outcome: 'issued', orgId: null, orgRole: null });
    expect(await refresh()).toMatchObject({ outcome: 'issued', orgId: null, orgRole: null });
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
