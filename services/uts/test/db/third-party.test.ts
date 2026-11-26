import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditEventSchema } from '@kilocode/sts-contracts';
import { UTS_SCOPE_REGISTRY } from '@kilocode/uts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IdentityStore } from '../../src/db/client';
import {
  type DelegatedExchangeInput,
  type GrantStore,
  identityStoreGrants,
} from '../../src/grants/store';
import { type ThirdPartyStore, identityStoreThirdParty } from '../../src/third-party/store';
import { TestDatabase, insertAccount } from './harness';

/**
 * Third-party clients, consent and the broker exchange (migration 0012) through the Worker's own
 * statements (`src/third-party/store.ts`, `src/grants/store.ts`), run as the app login. Browser
 * sessions and organization memberships, which the sign-in slice writes, are inserted as the owner.
 */

let db: TestDatabase;
let owner: pg.Client;
let app: pg.Client;
let grants: GrantStore;
let thirdParty: ThirdPartyStore;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  app = await db.connect('uts_app_a');
  const store = new IdentityStore(app);
  grants = identityStoreGrants(store);
  thirdParty = identityStoreThirdParty(store);
});
afterAll(() => db.drop());

const environment = 'development';
const SCOPE = 'kilo-mcp:catalog.read';
const DELEGATED = 'kilo-api:mcp.read';
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const token = () => randomBytes(32).toString('base64url');

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

/** A browser session whose sign-in was `minutesAgo` minutes ago; returns its cookie's hash. */
async function browserSession(accountId: string, minutesAgo = 1): Promise<Buffer> {
  const hash = sha256(token());
  await owner.query(
    `INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
     VALUES ($1, $2, now() - make_interval(mins => $3), '{passkey}', now() + interval '14 days',
             now() + interval '29 days')`,
    [accountId, hash, minutesAgo]
  );
  return hash;
}

async function client(): Promise<string> {
  const clientId = `https://client.example.com/${randomUUID()}/client.json`;
  await thirdParty.saveClient({
    clientId,
    metadata: {
      client_id: clientId,
      client_name: 'Example MCP client',
      redirect_uris: ['https://client.example.com/callback'],
    },
    etag: '"v1"',
    cacheSeconds: 600,
  });
  return clientId;
}

/** A consent family through the real statements: consent, code, code exchange. */
async function consentFamily(accountId: string, clientId: string, consentId: string) {
  const code = token();
  const verifier = token();
  const challenge = sha256(verifier).toString('base64url');
  expect(
    await grants.issueCode({
      environment,
      codeHash: sha256(code),
      client: { kind: 'third_party', clientId, consentId },
      accountId,
      browserSessionId: null,
      redirectUri: 'https://client.example.com/callback',
      audiences: ['kilo-mcp'],
      scopes: [SCOPE],
      orgId: null,
      codeChallenge: challenge,
      authTime: new Date(),
      amr: ['passkey'],
    })
  ).toEqual({ outcome: 'issued', orgRole: null });
  const familyId = randomUUID();
  const exchanged = await grants.exchangeCode({
    environment,
    codeHash: sha256(code),
    clientId,
    redirectUri: 'https://client.example.com/callback',
    codeChallenge: challenge,
    binding: { kind: 'third_party' },
    grantId: familyId,
    refreshTokenHash: sha256(token()),
    scopes: null,
    resources: null,
  });
  expect(exchanged.outcome).toBe('issued');
  return familyId;
}

/** A first-party CLI grant holding the MCP scope, through a code exchange. */
async function cliGrant(accountId: string): Promise<string> {
  const code = token();
  const verifier = token();
  const challenge = sha256(verifier).toString('base64url');
  const jkt = randomBytes(32);
  await grants.issueCode({
    environment,
    codeHash: sha256(code),
    client: { kind: 'first_party', clientId: 'kilo-cli', dpopJkt: jkt },
    accountId,
    browserSessionId: null,
    redirectUri: 'http://127.0.0.1:4100/callback',
    audiences: ['kilo-mcp'],
    scopes: [SCOPE],
    orgId: null,
    codeChallenge: challenge,
    authTime: new Date(),
    amr: ['passkey'],
  });
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
      device: {
        label: 'Kilo CLI',
        platform: 'linux',
        clientIp: '192.0.2.10',
        asn: 64500,
        country: 'DE',
        city: 'Berlin',
      },
    },
    grantId,
    refreshTokenHash: sha256(`kilo_rt_${token()}`),
    scopes: null,
    resources: null,
  });
  expect(exchanged.outcome).toBe('issued');
  return grantId;
}

function exchangeInput(
  overrides: Partial<DelegatedExchangeInput> &
    Pick<DelegatedExchangeInput, 'accountId' | 'clientId' | 'grantId'>
): DelegatedExchangeInput {
  return {
    environment,
    clientKind: 'third_party',
    orgId: null,
    subjectScope: SCOPE,
    subjectIssuedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
    subjectTokenId: randomUUID(),
    subjectKid: `uts-token-04-${'K'.repeat(43)}`,
    scope: DELEGATED,
    actor: 'kilo-mcp',
    lifetimeSeconds: 300,
    ...overrides,
  };
}

describe('client metadata cache', () => {
  it('stores and refreshes an active client, and keeps a blocked one blocked with its old copy', async () => {
    const clientId = await client();
    expect(await thirdParty.readClient(clientId)).toEqual({
      status: 'active',
      record: {
        clientId,
        name: 'Example MCP client',
        redirectUris: ['https://client.example.com/callback'],
      },
      etag: '"v1"',
      fresh: true,
    });
    await owner.query(
      `UPDATE uts.third_party_clients SET cache_expires_at = fetched_at WHERE client_id = $1`,
      [clientId]
    );
    expect(await thirdParty.readClient(clientId)).toMatchObject({ fresh: false });
    await thirdParty.extendClient(clientId, 900);
    expect(await thirdParty.readClient(clientId)).toMatchObject({ fresh: true });

    await owner.query(`UPDATE uts.third_party_clients SET status = 'blocked' WHERE client_id = $1`, [
      clientId,
    ]);
    expect(
      await thirdParty.saveClient({
        clientId,
        metadata: {
          client_id: clientId,
          client_name: 'Renamed',
          redirect_uris: ['https://other.example.com/callback'],
        },
        etag: null,
        cacheSeconds: 600,
      })
    ).toEqual({ status: 'blocked' });
    const row = await owner.query(
      'SELECT status, client_name FROM uts.third_party_clients WHERE client_id = $1',
      [clientId]
    );
    expect(row.rows).toEqual([{ status: 'blocked', client_name: 'Example MCP client' }]);
    expect(await thirdParty.readClient(`https://client.example.com/${randomUUID()}`)).toBeNull();
  });
});

describe('consent', () => {
  it('writes the consumed tier B pass, the consent, the notice and the audit row in one statement', async () => {
    const accountId = await insertAccount(owner);
    const clientId = await client();
    const session = await browserSession(accountId);
    const granted = await thirdParty.grantConsent({
      environment,
      sessionTokenHash: session,
      clientId,
      orgId: null,
      scopes: [SCOPE],
    });
    if (granted.outcome !== 'granted') throw new Error(`expected granted, got ${granted.outcome}`);
    const consent = await owner.query(
      `SELECT consent.scopes, consent.status, pass.status AS pass_status, pass.action, pass.tier,
         pass.satisfied_by::text AS checks
       FROM uts.third_party_consents AS consent
       JOIN uts.gate_passes AS pass ON pass.id = consent.gate_pass_id
       WHERE consent.id = $1`,
      [granted.consentId]
    );
    expect(consent.rows).toEqual([
      {
        scopes: [SCOPE],
        status: 'active',
        pass_status: 'consumed',
        action: 'third_party_approve',
        tier: 'b',
        checks: '{recent_sign_in}',
      },
    ]);
    const notices = await owner.query(
      'SELECT kind, details FROM uts.notices WHERE account_id = $1',
      [accountId]
    );
    expect(notices.rows).toEqual([{ kind: 'third_party_client_approved', details: { clientId } }]);
    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).toEqual(['ai.kilo.uts.consent.granted']);
    expect(rows[0].event.data.attributes).toMatchObject({
      clientId,
      consentId: granted.consentId,
      scopes: [SCOPE],
      gateChecks: ['recent_sign_in'],
    });

    // A second submit finds the consent and writes nothing.
    expect(
      await thirdParty.grantConsent({
        environment,
        sessionTokenHash: session,
        clientId,
        orgId: null,
        scopes: [SCOPE],
      })
    ).toEqual(granted);
    expect(await auditRows(accountId)).toHaveLength(1);
    expect(
      await thirdParty.findConsent({ accountId, clientId, orgId: null, scopes: [SCOPE] })
    ).toBe(granted.consentId);
    expect(
      await thirdParty.findConsent({ accountId, clientId, orgId: null, scopes: [DELEGATED] })
    ).toBeNull();
  });

  it('refuses a sign-in older than 10 minutes with one denied row a minute, and writes no consent', async () => {
    const accountId = await insertAccount(owner);
    const clientId = await client();
    const session = await browserSession(accountId, 20);
    const input = { environment, sessionTokenHash: session, clientId, orgId: null, scopes: [SCOPE] };
    expect(await thirdParty.grantConsent(input)).toEqual({ outcome: 'gate_required' });
    expect(await thirdParty.grantConsent(input)).toEqual({ outcome: 'gate_required' });
    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).toEqual(['ai.kilo.uts.gate.refused']);
    expect(
      (await owner.query('SELECT 1 FROM uts.third_party_consents WHERE account_id = $1', [accountId]))
        .rowCount
    ).toBe(0);
  });

  it('answers no_session, unknown_client and org_denied without writing', async () => {
    const accountId = await insertAccount(owner);
    const clientId = await client();
    const session = await browserSession(accountId);
    const base = { environment, sessionTokenHash: session, clientId, orgId: null, scopes: [SCOPE] };
    expect(await thirdParty.grantConsent({ ...base, sessionTokenHash: sha256(token()) })).toEqual({
      outcome: 'no_session',
    });
    expect(
      await thirdParty.grantConsent({ ...base, clientId: `https://client.example.com/${randomUUID()}` })
    ).toEqual({ outcome: 'unknown_client' });
    expect(await thirdParty.grantConsent({ ...base, orgId: randomUUID() })).toEqual({
      outcome: 'org_denied',
    });
    expect(await auditRows(accountId)).toEqual([]);
  });

  it('lists the account consents for its session only, and nothing without a session', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    expect(await thirdParty.listConsents(session)).toEqual([]);
    const clientId = await client();
    const granted = await thirdParty.grantConsent({
      environment,
      sessionTokenHash: session,
      clientId,
      orgId: null,
      scopes: [SCOPE],
    });
    expect(await thirdParty.listConsents(session)).toEqual([
      expect.objectContaining({
        consentId: granted.outcome === 'granted' ? granted.consentId : null,
        clientId,
        clientName: 'Example MCP client',
        scopes: [SCOPE],
        orgId: null,
      }),
    ]);
    expect(await thirdParty.listConsents(sha256(token()))).toBeNull();
    // Another account's session sees none of them.
    expect(await thirdParty.listConsents(await browserSession(await insertAccount(owner)))).toEqual(
      []
    );
  });
});

describe('the broker exchange statement', () => {
  async function consentedFamily() {
    const accountId = await insertAccount(owner);
    const clientId = await client();
    const session = await browserSession(accountId);
    const granted = await thirdParty.grantConsent({
      environment,
      sessionTokenHash: session,
      clientId,
      orgId: null,
      scopes: [SCOPE],
    });
    if (granted.outcome !== 'granted') throw new Error('expected a consent');
    const familyId = await consentFamily(accountId, clientId, granted.consentId);
    return { accountId, clientId, session, consentId: granted.consentId, familyId };
  }

  it('issues for a live consent family and writes token.exchanged with the token, actor and subject token', async () => {
    const { accountId, clientId, familyId } = await consentedFamily();
    const input = exchangeInput({ accountId, clientId, grantId: familyId });
    const result = await grants.exchangeDelegated(input);
    if (result.outcome !== 'issued') throw new Error(`expected issued, got ${result.outcome}`);
    const [row] = (await auditRows(accountId)).filter(
      audit => audit.type === 'ai.kilo.uts.token.exchanged'
    );
    expect(row.event.data.outcome).toBe('success');
    expect(row.event.data.attributes).toEqual({
      grantType: 'token_exchange',
      clientId,
      clientKind: 'third_party',
      grantId: familyId,
      actor: 'kilo-mcp',
      subjectTokenRef: input.subjectTokenId,
      subjectScope: SCOPE,
      tokenRefs: [result.tokenId],
      scopes: [DELEGATED],
      audiences: ['kilo-api'],
      tokenLifetimeSeconds: ['300'],
    });
  });

  it('refuses a scope the subject does not delegate, and one the consent does not hold', async () => {
    const { accountId, clientId, familyId } = await consentedFamily();
    expect(
      await grants.exchangeDelegated(
        exchangeInput({ accountId, clientId, grantId: familyId, scope: 'kilo-api:profile.read' })
      )
    ).toEqual({ outcome: 'invalid_scope' });
    expect(
      await grants.exchangeDelegated(
        exchangeInput({
          accountId,
          clientId,
          grantId: familyId,
          subjectScope: 'kilo-mcp:tools.read',
        })
      )
    ).toEqual({ outcome: 'invalid_scope' });
  });

  it('refuses after the consent is withdrawn: the families end with third_party_family feed entries', async () => {
    const { accountId, clientId, session, consentId, familyId } = await consentedFamily();
    const secondFamily = await consentFamily(accountId, clientId, consentId);
    const withdrawn = await thirdParty.withdrawConsent({
      environment,
      sessionTokenHash: session,
      consentId,
    });
    if (withdrawn.outcome !== 'withdrawn') throw new Error('expected withdrawn');
    expect(withdrawn.endedFamilies).toBe(2);
    expect(withdrawn.feedEntries.map(entry => [entry.kind, entry.id]).sort()).toEqual(
      [
        ['third_party_family', familyId],
        ['third_party_family', secondFamily],
      ].sort()
    );
    expect(withdrawn.feedEntries.every(entry => entry.revokedBefore === null)).toBe(true);
    // No subject-wide entry: other grants of the account keep working.
    expect(
      (
        await owner.query(`SELECT 1 FROM uts.revocations WHERE kind = 'subject' AND subject_id = $1`, [
          accountId,
        ])
      ).rowCount
    ).toBe(0);
    expect(
      await grants.exchangeDelegated(exchangeInput({ accountId, clientId, grantId: familyId }))
    ).toEqual({ outcome: 'invalid_grant' });
    expect(
      await grants.exchangeDelegated(exchangeInput({ accountId, clientId, grantId: familyId }))
    ).toEqual({ outcome: 'invalid_grant' });
    const types = (await auditRows(accountId)).map(row => row.type);
    expect(types.filter(type => type === 'ai.kilo.uts.consent.withdrawn')).toHaveLength(1);
    // Two refusals within the minute write one denied row.
    expect(types.filter(type => type === 'ai.kilo.uts.token.exchange_refused')).toHaveLength(1);
    expect(
      await thirdParty.withdrawConsent({ environment, sessionTokenHash: session, consentId })
    ).toEqual({ outcome: 'not_found' });
  });

  it('refuses another account, another client, another organization and an unknown grant', async () => {
    const { accountId, clientId, familyId } = await consentedFamily();
    for (const input of [
      exchangeInput({ accountId: await insertAccount(owner), clientId, grantId: familyId }),
      exchangeInput({ accountId, clientId: await client(), grantId: familyId }),
      exchangeInput({ accountId, clientId, grantId: familyId, orgId: randomUUID() }),
      exchangeInput({ accountId, clientId, grantId: randomUUID() }),
    ]) {
      expect(await grants.exchangeDelegated(input)).toEqual({ outcome: 'invalid_grant' });
    }
  });

  it('refuses a blocked client at once', async () => {
    const { accountId, clientId, familyId } = await consentedFamily();
    await owner.query(`UPDATE uts.third_party_clients SET status = 'blocked' WHERE client_id = $1`, [
      clientId,
    ]);
    expect(
      await grants.exchangeDelegated(exchangeInput({ accountId, clientId, grantId: familyId }))
    ).toEqual({ outcome: 'invalid_grant' });
  });

  it('issues for a live kilo-cli grant without a consent, and refuses once the subject or the key is revoked', async () => {
    const accountId = await insertAccount(owner);
    const grantId = await cliGrant(accountId);
    const input = exchangeInput({
      accountId,
      clientId: 'kilo-cli',
      clientKind: 'first_party',
      grantId,
      subjectIssuedAt: new Date(Date.now() - 60_000),
    });
    expect((await grants.exchangeDelegated(input)).outcome).toBe('issued');

    await owner.query(
      `INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
       VALUES ('kid', $1, now() + interval '1 hour')`,
      [input.subjectKid]
    );
    expect(await grants.exchangeDelegated(input)).toEqual({ outcome: 'invalid_grant' });
    const otherKid = { ...input, subjectKid: `uts-token-07-${'Q'.repeat(43)}` };
    expect((await grants.exchangeDelegated(otherKid)).outcome).toBe('issued');

    await owner.query(
      `INSERT INTO uts.revocations (kind, subject_id, revoked_before, feed_expires_at)
       VALUES ('subject', $1, now(), now() + interval '1 hour')`,
      [accountId]
    );
    expect(await grants.exchangeDelegated(otherKid)).toEqual({ outcome: 'invalid_grant' });
    // A subject token issued after the revocation is not refused by it.
    const later = { ...otherKid, subjectIssuedAt: new Date(Date.now() + 2_000) };
    expect((await grants.exchangeDelegated(later)).outcome).toBe('issued');

    await owner.query(
      `UPDATE uts.refresh_grants SET status = 'revoked', revoked_at = now(), revoke_reason = 'sign_out'
       WHERE id = $1`,
      [grantId]
    );
    expect(await grants.exchangeDelegated(later)).toEqual({ outcome: 'invalid_grant' });
  });

  it('refuses a lifetime outside 1 to 300 seconds', async () => {
    const { accountId, clientId, familyId } = await consentedFamily();
    await expect(
      grants.exchangeDelegated(
        exchangeInput({ accountId, clientId, grantId: familyId, lifetimeSeconds: 301 })
      )
    ).rejects.toMatchObject({ sqlState: '22023' });
  });
});

describe('the registry mirrors', () => {
  it('delegate exactly as UTS_SCOPE_REGISTRY says', async () => {
    const scopes = Object.keys(UTS_SCOPE_REGISTRY);
    const result = await owner.query<{ scope: string; delegated: string[] }>(
      'SELECT scope, uts.delegated_scopes(scope) AS delegated FROM unnest($1::text[]) AS scope',
      [scopes]
    );
    expect(Object.fromEntries(result.rows.map(row => [row.scope, row.delegated]))).toEqual(
      Object.fromEntries(
        Object.entries(UTS_SCOPE_REGISTRY).map(([scope, entry]) => [scope, [...entry.delegatesTo]])
      )
    );
  });
});
