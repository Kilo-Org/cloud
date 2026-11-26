import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditEventSchema, OCSF_CLASS } from '@kilocode/sts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IdentityStore } from '../../src/db/client';
import {
  type DeviceContext,
  type ExchangeCodeInput,
  type FirstPartyRefreshInput,
  type GrantStore,
  type IssueCodeInput,
  type ProofBinding,
  identityStoreGrants,
} from '../../src/grants/store';
import { TestDatabase, insertAccount, insertGatePass, sqlStateOf } from './harness';

/**
 * The OAuth grant functions (migration 0004) through the Worker's own statements
 * (`src/grants/store.ts`), run as the app login against the migrated schema. Fixtures that the
 * sign-in and consent slices will write (accounts, memberships, clients, consents) are inserted as
 * the owner.
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
const reference = (value: string) => sha256(value).toString('base64url').slice(0, 8);
const token = () => randomBytes(32).toString('base64url');
/** A verified DPoP proof of the key `jkt`, with a fresh `jti`. */
const proofOf = (jkt: Buffer): ProofBinding => ({ jkt, jti: randomUUID() });
const device: DeviceContext = {
  label: 'Kilo CLI',
  platform: 'linux',
  clientIp: '192.0.2.10',
  asn: 64500,
  country: 'DE',
  city: 'Berlin',
};

const AuditRowSchema = z.object({
  event_type: z.string(),
  account_id: z.string(),
  event: z.unknown(),
});

/** The audit rows of one account, oldest first, each checked against the audit event contract. */
async function auditRows(accountId: string) {
  const result = await owner.query(
    'SELECT event_type, account_id, event FROM uts.audit_events WHERE account_id = $1 ORDER BY id',
    [accountId]
  );
  return result.rows.map(row => {
    const parsed = AuditRowSchema.parse(row);
    return { type: parsed.event_type, event: AuditEventSchema.parse(parsed.event) };
  });
}

async function eventsText(accountId: string): Promise<string> {
  const result = await owner.query<{ text: string }>(
    `SELECT coalesce(string_agg(event::text, ' '), '') AS text FROM uts.audit_events WHERE account_id = $1`,
    [accountId]
  );
  return result.rows[0].text;
}

type CodeFixture = { code: string; verifier: string; challenge: string; jkt: Buffer };
/** What a refresh needs from a first-party grant. */
type GrantFixture = { refreshToken: string; grantId: string; jkt: Buffer };

async function issueFirstPartyCode(
  accountId: string,
  overrides: Partial<IssueCodeInput> = {},
  scopes = ['gateway:models.read', 'kilo-chat:messages.read']
): Promise<CodeFixture> {
  const code = token();
  const verifier = token();
  const challenge = sha256(verifier).toString('base64url');
  const jkt = randomBytes(32);
  const outcome = await grants.issueCode({
    environment,
    codeHash: sha256(code),
    client: { kind: 'first_party', clientId: 'kilo-cli', dpopJkt: jkt },
    accountId,
    browserSessionId: null,
    redirectUri: 'http://127.0.0.1:4100/callback',
    audiences: [...new Set(scopes.map(scope => scope.split(':')[0]))],
    scopes,
    orgId: null,
    codeChallenge: challenge,
    authTime: new Date(),
    amr: ['passkey'],
    ...overrides,
  });
  expect(outcome).toBe('issued');
  return { code, verifier, challenge, jkt };
}

function exchangeInput(
  fixture: CodeFixture,
  overrides: Partial<ExchangeCodeInput> = {}
): ExchangeCodeInput & { refreshToken: string } {
  const refreshToken = `kilo_rt_${token()}`;
  return {
    environment,
    codeHash: sha256(fixture.code),
    clientId: 'kilo-cli',
    redirectUri: 'http://127.0.0.1:4100/callback',
    codeChallenge: fixture.challenge,
    binding: { kind: 'first_party', proof: proofOf(fixture.jkt), clientClass: 'desktop', device },
    grantId: randomUUID(),
    refreshTokenHash: sha256(refreshToken),
    scopes: null,
    resources: null,
    refreshToken,
    ...overrides,
  };
}

/** A first-party grant created through a code exchange. */
async function firstPartyGrant(accountId: string, clientClass: 'desktop' | 'mobile' = 'desktop') {
  const fixture = await issueFirstPartyCode(accountId);
  const input = exchangeInput(fixture, {
    binding: { kind: 'first_party', proof: proofOf(fixture.jkt), clientClass, device },
  });
  const result = await grants.exchangeCode(input);
  expect(result.outcome).toBe('issued');
  return { ...input, jkt: fixture.jkt, codeHash: input.codeHash };
}

async function thirdPartyConsent(accountId: string, scopes = '{mcp:tools.read}') {
  const clientId = `https://client.example.com/${randomUUID()}`;
  await owner.query(
    `INSERT INTO uts.third_party_clients
       (client_id, client_name, redirect_uris, document, fetched_at, cache_expires_at)
     VALUES ($1, 'Example', '{https://client.example.com/callback}', '{}', now(), now() + interval '1 hour')`,
    [clientId]
  );
  const consent = await owner.query<{ id: string }>(
    `INSERT INTO uts.third_party_consents (account_id, client_id, scopes, gate_pass_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [accountId, clientId, scopes, await insertGatePass(owner, accountId, 'third_party_approve')]
  );
  return { clientId, consentId: consent.rows[0].id };
}

/**
 * A third-party family created through a code exchange; returns its first refresh token and the
 * exchange it came from.
 */
async function thirdPartyFamily(accountId: string) {
  const { clientId, consentId } = await thirdPartyConsent(accountId);
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
      audiences: ['mcp'],
      scopes: ['mcp:tools.read'],
      orgId: null,
      codeChallenge: challenge,
      authTime: new Date(),
      amr: ['oauth'],
    })
  ).toBe('issued');
  const refreshToken = token();
  const familyId = randomUUID();
  const exchange: ExchangeCodeInput = {
    environment,
    codeHash: sha256(code),
    clientId,
    redirectUri: 'https://client.example.com/callback',
    codeChallenge: challenge,
    binding: { kind: 'third_party' },
    grantId: familyId,
    refreshTokenHash: sha256(refreshToken),
    scopes: null,
    resources: null,
  };
  expect((await grants.exchangeCode(exchange)).outcome).toBe('issued');
  return { clientId, familyId, refreshToken, exchange };
}

function refreshThirdParty(clientId: string, presented: string, next = token()) {
  return {
    next,
    result: grants.refreshThirdParty({
      environment,
      tokenHash: sha256(presented),
      clientId,
      newTokenHash: sha256(next),
      scopes: null,
      resources: null,
    }),
  };
}

describe('authorization codes', () => {
  it('stores a first-party code with its DPoP key and writes one audit row without the code', async () => {
    const accountId = await insertAccount(owner);
    const fixture = await issueFirstPartyCode(accountId);
    const stored = await owner.query(
      'SELECT client_kind, dpop_jkt, scopes, resources, status FROM uts.authorization_codes WHERE code_hash = $1',
      [sha256(fixture.code)]
    );
    expect(stored.rows).toEqual([
      {
        client_kind: 'first_party',
        dpop_jkt: fixture.jkt,
        scopes: ['gateway:models.read', 'kilo-chat:messages.read'],
        resources: '{gateway,kilo-chat}',
        status: 'issued',
      },
    ]);
    const [row, ...rest] = await auditRows(accountId);
    expect(rest).toEqual([]);
    expect(row.type).toBe('ai.kilo.uts.authorization_code.issued');
    expect(row.event.data).toMatchObject({
      classUid: OCSF_CLASS.apiActivity,
      outcome: 'success',
      actor: { kind: 'user', id: accountId },
      attributes: {
        clientId: 'kilo-cli',
        codeRef: reference(fixture.code),
        scopes: ['gateway:models.read', 'kilo-chat:messages.read'],
        audiences: ['gateway', 'kilo-chat'],
      },
    });
    expect(await eventsText(accountId)).not.toContain(fixture.code);
  });

  it('refuses a blocked account and an unmet org requirement', async () => {
    const blocked = await insertAccount(owner);
    await owner.query(
      `UPDATE uts.accounts SET status = 'blocked', blocked_at = now() WHERE id = $1`,
      [blocked]
    );
    const base = {
      environment,
      codeHash: sha256(token()),
      client: { kind: 'first_party', clientId: 'kilo-cli', dpopJkt: randomBytes(32) },
      browserSessionId: null,
      redirectUri: 'http://127.0.0.1:4100/callback',
      audiences: ['gateway'],
      scopes: ['gateway:models.read'],
      codeChallenge: sha256(token()).toString('base64url'),
      authTime: new Date(),
      amr: ['passkey'],
    } satisfies Partial<IssueCodeInput>;
    expect(await grants.issueCode({ ...base, accountId: blocked, orgId: null })).toBe(
      'access_denied'
    );

    const member = await insertAccount(owner);
    const orgId = randomUUID();
    expect(await grants.issueCode({ ...base, accountId: member, orgId })).toBe('access_denied');
    await owner.query(
      `INSERT INTO uts.org_memberships (org_id, account_id, role, event_version) VALUES ($1, $2, 'member', 1)`,
      [orgId, member]
    );
    await owner.query(
      `INSERT INTO uts.org_sso_policies (org_id, enforcement, event_version) VALUES ($1, 'required', 1)`,
      [orgId]
    );
    expect(await grants.issueCode({ ...base, accountId: member, orgId })).toBe('access_denied');
    expect(
      await grants.issueCode({
        ...base,
        codeHash: sha256(token()),
        accountId: member,
        orgId,
        amr: ['sso'],
      })
    ).toBe('issued');
  });

  it('needs an active consent that covers the scopes for a third-party client', async () => {
    const accountId = await insertAccount(owner);
    const { clientId, consentId } = await thirdPartyConsent(accountId);
    const issue = (scopes: string[], consent: string) =>
      grants.issueCode({
        environment,
        codeHash: sha256(token()),
        client: { kind: 'third_party', clientId, consentId: consent },
        accountId,
        browserSessionId: null,
        redirectUri: 'https://client.example.com/callback',
        audiences: ['mcp'],
        scopes,
        orgId: null,
        codeChallenge: sha256(token()).toString('base64url'),
        authTime: new Date(),
        amr: ['oauth'],
      });
    expect(await issue(['mcp:tools.write'], consentId)).toBe('consent_required');
    expect(await issue(['mcp:tools.read'], randomUUID())).toBe('consent_required');
    expect(await issue(['mcp:tools.read'], consentId)).toBe('issued');
  });
});

describe('code exchange', () => {
  it('creates a device session and a DPoP-bound desktop grant, and lists every jti in one audit row', async () => {
    const accountId = await insertAccount(owner);
    const fixture = await issueFirstPartyCode(accountId);
    const input = exchangeInput(fixture);
    const result = await grants.exchangeCode(input);
    if (result.outcome !== 'issued') throw new Error(result.outcome);
    expect(result.subjectId).toBe(accountId);
    expect(result.amr).toEqual(['passkey']);
    expect(result.scopes).toEqual(['gateway:models.read', 'kilo-chat:messages.read']);
    expect(result.tokenIds).toHaveLength(2);

    const grant = await owner.query(
      `SELECT grant_row.dpop_jkt, grant_row.client_class, grant_row.allowed_scopes,
              grant_row.idle_expires_at - grant_row.created_at AS idle,
              grant_row.expires_at - grant_row.created_at AS lifetime,
              session.device_label, session.platform, host(session.client_ip) AS ip, session.country
       FROM uts.refresh_grants AS grant_row
       JOIN uts.device_sessions AS session ON session.id = grant_row.device_session_id
       WHERE grant_row.id = $1`,
      [input.grantId]
    );
    expect(grant.rows).toEqual([
      expect.objectContaining({
        dpop_jkt: fixture.jkt,
        client_class: 'desktop',
        allowed_scopes: ['gateway:models.read', 'kilo-chat:messages.read'],
        idle: { days: 30 },
        lifetime: { days: 180 },
        device_label: 'Kilo CLI',
        platform: 'linux',
        ip: '192.0.2.10',
        country: 'DE',
      }),
    ]);
    const code = await owner.query(
      'SELECT status, grant_id FROM uts.authorization_codes WHERE code_hash = $1',
      [input.codeHash]
    );
    expect(code.rows).toEqual([{ status: 'consumed', grant_id: input.grantId }]);

    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).toEqual([
      'ai.kilo.uts.authorization_code.issued',
      'ai.kilo.uts.grant.created',
    ]);
    expect(rows[1].event.data).toMatchObject({
      classUid: OCSF_CLASS.authentication,
      activityId: 1,
      attributes: {
        grantType: 'authorization_code',
        grantId: input.grantId,
        tokenRefs: result.tokenIds,
        scopes: result.scopes,
        audiences: ['gateway', 'kilo-chat'],
        refreshRef: reference(input.refreshToken),
        tokenLifetimeSeconds: 600,
      },
    });
    const text = await eventsText(accountId);
    expect(text).not.toContain(input.refreshToken);
    expect(text).not.toContain(fixture.code);
  });

  it('gives a mobile grant 60 days idle and 1 year in total', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId, 'mobile');
    const stored = await owner.query(
      `SELECT idle_expires_at - created_at AS idle, expires_at - created_at AS lifetime
       FROM uts.refresh_grants WHERE id = $1`,
      [grant.grantId]
    );
    expect(stored.rows).toEqual([{ idle: { days: 60 }, lifetime: { days: 365 } }]);
  });

  it.each([
    [
      'another verifier',
      (input: ExchangeCodeInput) => ({
        ...input,
        codeChallenge: sha256(token()).toString('base64url'),
      }),
    ],
    [
      'another redirect URI',
      (input: ExchangeCodeInput) => ({ ...input, redirectUri: 'http://127.0.0.1:4200/callback' }),
    ],
    ['another client', (input: ExchangeCodeInput) => ({ ...input, clientId: 'kilo-other' })],
    [
      'another DPoP key',
      (input: ExchangeCodeInput) => ({
        ...input,
        binding: {
          kind: 'first_party' as const,
          proof: proofOf(randomBytes(32)),
          clientClass: 'desktop' as const,
          device,
        },
      }),
    ],
    [
      'a third-party binding',
      (input: ExchangeCodeInput) => ({ ...input, binding: { kind: 'third_party' as const } }),
    ],
    ['an unknown code', (input: ExchangeCodeInput) => ({ ...input, codeHash: sha256(token()) })],
  ])('refuses %s and leaves the code unused', async (_name, change) => {
    const accountId = await insertAccount(owner);
    const fixture = await issueFirstPartyCode(accountId);
    const input = exchangeInput(fixture);
    expect(await grants.exchangeCode(change(input))).toEqual({ outcome: 'invalid_grant' });
    expect((await grants.exchangeCode(input)).outcome).toBe('issued');
  });

  it('refuses an expired code', async () => {
    const accountId = await insertAccount(owner);
    const fixture = await issueFirstPartyCode(accountId);
    await owner.query(
      `UPDATE uts.authorization_codes
       SET created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
       WHERE code_hash = $1`,
      [sha256(fixture.code)]
    );
    expect(await grants.exchangeCode(exchangeInput(fixture))).toEqual({ outcome: 'invalid_grant' });
  });

  it('selects the requested scopes and refuses a scope or resource outside the code', async () => {
    const accountId = await insertAccount(owner);
    const fixture = await issueFirstPartyCode(accountId);
    expect(
      await grants.exchangeCode(exchangeInput(fixture, { scopes: ['gateway:chat.write'] }))
    ).toEqual({ outcome: 'invalid_scope' });
    expect(await grants.exchangeCode(exchangeInput(fixture, { resources: ['mcp'] }))).toEqual({
      outcome: 'invalid_target',
    });
    const result = await grants.exchangeCode(exchangeInput(fixture, { resources: ['kilo-chat'] }));
    expect(result).toMatchObject({ outcome: 'issued', scopes: ['kilo-chat:messages.read'] });
  });

  it('records the proof jti under the proof key, so each proof works once', async () => {
    const accountId = await insertAccount(owner);
    const fixture = await issueFirstPartyCode(accountId);
    const input = exchangeInput(fixture);
    // A refused scope still uses the proof up.
    expect(await grants.exchangeCode({ ...input, scopes: ['gateway:chat.write'] })).toEqual({
      outcome: 'invalid_scope',
    });
    expect(await grants.exchangeCode(input)).toEqual({ outcome: 'dpop_replay' });
    const fresh = await grants.exchangeCode({
      ...input,
      binding: { kind: 'first_party', proof: proofOf(fixture.jkt), clientClass: 'desktop', device },
    });
    expect(fresh.outcome).toBe('issued');
    const stored = await owner.query(
      'SELECT count(*)::int AS proofs FROM uts.dpop_proofs WHERE jkt = $1',
      [fixture.jkt]
    );
    expect(stored.rows).toEqual([{ proofs: 2 }]);
  });

  it('revokes the grant a code created when the code is used again', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    expect(await grants.exchangeCode({ ...grant, grantId: randomUUID() })).toEqual({
      outcome: 'invalid_grant',
    });
    const stored = await owner.query(
      `SELECT grant_row.status, grant_row.revoke_reason, session.status AS session_status
       FROM uts.refresh_grants AS grant_row
       JOIN uts.device_sessions AS session ON session.id = grant_row.device_session_id
       WHERE grant_row.id = $1`,
      [grant.grantId]
    );
    expect(stored.rows).toEqual([
      { status: 'revoked', revoke_reason: 'reuse_detected', session_status: 'revoked' },
    ]);
    const feed = await owner.query(
      `SELECT kind, feed_expires_at - revoked_at AS kept FROM uts.revocations WHERE subject_id = $1`,
      [grant.grantId]
    );
    expect(feed.rows).toEqual([{ kind: 'grant', kept: { minutes: 20 } }]);
    const rows = await auditRows(accountId);
    expect(rows.at(-1)).toMatchObject({
      type: 'ai.kilo.uts.authorization_code.reused',
      event: { data: { outcome: 'denied', attributes: { grantId: grant.grantId } } },
    });
  });

  it('answers a retry of the same exchange with the same grant and a new refresh token', async () => {
    const accountId = await insertAccount(owner);
    const first = await firstPartyGrant(accountId);
    // The signing failed after the first exchange committed; the client sends the request again
    // with a new DPoP proof.
    const retryToken = `kilo_rt_${token()}`;
    const retried = await grants.exchangeCode({
      ...first,
      binding: { kind: 'first_party', proof: proofOf(first.jkt), clientClass: 'desktop', device },
      refreshTokenHash: sha256(retryToken),
    });
    if (retried.outcome !== 'issued') throw new Error(retried.outcome);
    expect(retried.subjectId).toBe(accountId);
    expect(retried.scopes).toEqual(['gateway:models.read', 'kilo-chat:messages.read']);

    const stored = await owner.query(
      `SELECT grant_row.id, grant_row.status, grant_row.token_hash
       FROM uts.refresh_grants AS grant_row WHERE grant_row.account_id = $1`,
      [accountId]
    );
    expect(stored.rows).toEqual([
      { id: first.grantId, status: 'active', token_hash: sha256(retryToken) },
    ]);
    const refresh = (refreshToken: string) =>
      grants.refreshFirstParty({
        environment,
        tokenHash: sha256(refreshToken),
        grantId: first.grantId,
        clientId: 'kilo-cli',
        proof: proofOf(first.jkt),
        scopes: null,
        resources: null,
      });
    expect(await refresh(first.refreshToken)).toEqual({ outcome: 'invalid_grant' });
    expect((await refresh(retryToken)).outcome).toBe('issued');

    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).not.toContain('ai.kilo.uts.authorization_code.reused');
    const retryRow = rows.find(row => row.event.data.attributes.rotation === 'code_retry');
    expect(retryRow).toMatchObject({
      type: 'ai.kilo.uts.token.issued',
      event: {
        data: {
          attributes: {
            grantType: 'authorization_code',
            grantId: first.grantId,
            previousRefreshRef: reference(first.refreshToken),
            refreshRef: reference(retryToken),
            tokenRefs: retried.tokenIds,
          },
        },
      },
    });
  });

  it('refuses a retry that replays the first proof, and leaves the grant active', async () => {
    const accountId = await insertAccount(owner);
    const first = await firstPartyGrant(accountId);
    expect(await grants.exchangeCode({ ...first, refreshTokenHash: sha256(token()) })).toEqual({
      outcome: 'dpop_replay',
    });
    const stored = await owner.query('SELECT status FROM uts.refresh_grants WHERE id = $1', [
      first.grantId,
    ]);
    expect(stored.rows).toEqual([{ status: 'active' }]);
  });

  it.each([
    [
      'another verifier',
      (input: ExchangeCodeInput) => ({
        ...input,
        codeChallenge: sha256(token()).toString('base64url'),
      }),
    ],
    [
      'another DPoP key',
      (input: ExchangeCodeInput) => ({
        ...input,
        binding: {
          kind: 'first_party' as const,
          proof: proofOf(randomBytes(32)),
          clientClass: 'desktop' as const,
          device,
        },
      }),
    ],
    ['another client', (input: ExchangeCodeInput) => ({ ...input, clientId: 'kilo-other' })],
  ])('revokes the grant when a retry comes with %s', async (_name, change) => {
    const accountId = await insertAccount(owner);
    const first = await firstPartyGrant(accountId);
    const retry = change({
      ...first,
      binding: { kind: 'first_party', proof: proofOf(first.jkt), clientClass: 'desktop', device },
      refreshTokenHash: sha256(token()),
    });
    expect(await grants.exchangeCode(retry)).toEqual({ outcome: 'invalid_grant' });
    const stored = await owner.query(
      'SELECT status, revoke_reason, token_hash FROM uts.refresh_grants WHERE id = $1',
      [first.grantId]
    );
    expect(stored.rows).toEqual([
      { status: 'revoked', revoke_reason: 'reuse_detected', token_hash: first.refreshTokenHash },
    ]);
    expect((await auditRows(accountId)).at(-1)?.type).toBe('ai.kilo.uts.authorization_code.reused');
  });

  it('revokes the grant when the same request comes again after the code lifetime', async () => {
    const accountId = await insertAccount(owner);
    const first = await firstPartyGrant(accountId);
    await owner.query(
      `UPDATE uts.authorization_codes
       SET created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute',
           consumed_at = now() - interval '90 seconds'
       WHERE code_hash = $1`,
      [first.codeHash]
    );
    const retry = {
      ...first,
      binding: {
        kind: 'first_party' as const,
        proof: proofOf(first.jkt),
        clientClass: 'desktop' as const,
        device,
      },
      refreshTokenHash: sha256(token()),
    };
    expect(await grants.exchangeCode(retry)).toEqual({ outcome: 'invalid_grant' });
    const stored = await owner.query('SELECT status FROM uts.refresh_grants WHERE id = $1', [
      first.grantId,
    ]);
    expect(stored.rows).toEqual([{ status: 'revoked' }]);
  });

  it('revokes a third-party family when the same exchange comes again', async () => {
    const accountId = await insertAccount(owner);
    const family = await thirdPartyFamily(accountId);
    // Same client, redirect URI and verifier inside the code lifetime: a third-party client has no
    // DPoP key, so the verifier alone does not show the same client instance.
    expect(
      await grants.exchangeCode({ ...family.exchange, refreshTokenHash: sha256(token()) })
    ).toEqual({ outcome: 'invalid_grant' });
    const stored = await owner.query(
      'SELECT status, revoke_reason FROM uts.third_party_grant_families WHERE id = $1',
      [family.familyId]
    );
    expect(stored.rows).toEqual([{ status: 'revoked', revoke_reason: 'reuse_detected' }]);
    const tokens = await owner.query(
      'SELECT token_hash, status FROM uts.third_party_refresh_tokens WHERE family_id = $1',
      [family.familyId]
    );
    expect(tokens.rows).toEqual([{ token_hash: sha256(family.refreshToken), status: 'active' }]);
    const rows = await auditRows(accountId);
    expect(rows.at(-1)).toMatchObject({
      type: 'ai.kilo.uts.authorization_code.reused',
      event: { data: { outcome: 'denied', attributes: { grantId: family.familyId } } },
    });
    expect(rows.map(row => row.event.data.attributes.rotation)).not.toContain('code_retry');
    expect(await refreshThirdParty(family.clientId, family.refreshToken).result).toEqual({
      outcome: 'invalid_grant',
    });
  });

  it('creates a third-party family whose id is the grant id, with its first token', async () => {
    const accountId = await insertAccount(owner);
    const { familyId, refreshToken } = await thirdPartyFamily(accountId);
    const stored = await owner.query(
      `SELECT family.expires_at - family.created_at AS lifetime, token.status,
              token.idle_expires_at - token.issued_at AS idle
       FROM uts.third_party_grant_families AS family
       JOIN uts.third_party_refresh_tokens AS token ON token.family_id = family.id
       WHERE family.id = $1 AND token.token_hash = $2`,
      [familyId, sha256(refreshToken)]
    );
    expect(stored.rows).toEqual([{ lifetime: { days: 90 }, status: 'active', idle: { days: 30 } }]);
  });
});

describe('first-party refresh', () => {
  const refresh = (grant: GrantFixture, overrides: Partial<FirstPartyRefreshInput> = {}) =>
    grants.refreshFirstParty({
      environment,
      tokenHash: sha256(grant.refreshToken),
      grantId: grant.grantId,
      clientId: 'kilo-cli',
      proof: proofOf(grant.jkt),
      scopes: null,
      resources: null,
      ...overrides,
    });

  it('records the proof jti under the proof key and refuses it a second time', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const proof = proofOf(grant.jkt);
    expect((await refresh(grant, { proof })).outcome).toBe('issued');
    const before = (await auditRows(accountId)).length;
    expect(await refresh(grant, { proof })).toEqual({ outcome: 'dpop_replay' });
    expect(await auditRows(accountId)).toHaveLength(before);
    const stored = await owner.query<{ kept: number }>(
      `SELECT extract(epoch FROM expires_at - now()) AS kept FROM uts.dpop_proofs
       WHERE jkt = $1 AND jti = $2`,
      [grant.jkt, proof.jti]
    );
    expect(Number(stored.rows[0].kept)).toBeGreaterThan(119);
    expect(Number(stored.rows[0].kept)).toBeLessThanOrEqual(121);
    // The same jti under another key is another proof.
    const other = await firstPartyGrant(accountId);
    const sameJti = await refresh(other, { proof: { jkt: other.jkt, jti: proof.jti } });
    expect(sameJti.outcome).toBe('issued');
  });

  it('refuses a proof accepted for one grant of a device key at another grant of that key', async () => {
    const accountId = await insertAccount(owner);
    const first = await firstPartyGrant(accountId);
    // A second sign-in on the same device: its code and grant bind the same key.
    const fixture = await issueFirstPartyCode(accountId, {
      client: { kind: 'first_party', clientId: 'kilo-cli', dpopJkt: first.jkt },
    });
    const second = exchangeInput({ ...fixture, jkt: first.jkt });
    expect((await grants.exchangeCode(second)).outcome).toBe('issued');
    const proof = proofOf(first.jkt);
    expect((await refresh(first, { proof })).outcome).toBe('issued');
    expect(await refresh({ ...second, jkt: first.jkt }, { proof })).toEqual({
      outcome: 'dpop_replay',
    });
    expect((await refresh({ ...second, jkt: first.jkt })).outcome).toBe('issued');
  });

  it('records no jti for a proof of another key', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const stolen = proofOf(randomBytes(32));
    expect(await refresh(grant, { proof: stolen })).toEqual({ outcome: 'dpop_mismatch' });
    const stored = await owner.query('SELECT 1 FROM uts.dpop_proofs WHERE jti = $1', [stolen.jti]);
    expect(stored.rows).toEqual([]);
  });

  it('mints one token per granted scope and audits each jti', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const result = await refresh(grant, { scopes: ['gateway:models.read'] });
    if (result.outcome !== 'issued') throw new Error(result.outcome);
    expect(result.scopes).toEqual(['gateway:models.read']);
    const rows = await auditRows(accountId);
    expect(rows.at(-1)).toMatchObject({
      type: 'ai.kilo.uts.token.issued',
      event: {
        data: {
          classUid: OCSF_CLASS.apiActivity,
          attributes: {
            grantType: 'refresh_token',
            grantId: grant.grantId,
            tokenRefs: result.tokenIds,
          },
        },
      },
    });
    expect(await eventsText(accountId)).not.toContain(grant.refreshToken);
  });

  it('moves last use and the idle window at most once per hour', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const lastUse = async () =>
      (
        await owner.query<{ last_used_at: Date }>(
          'SELECT last_used_at FROM uts.refresh_grants WHERE id = $1',
          [grant.grantId]
        )
      ).rows[0].last_used_at.getTime();
    const created = await lastUse();
    await refresh(grant);
    expect(await lastUse()).toBe(created);

    await owner.query(
      `UPDATE uts.refresh_grants
       SET last_used_at = now() - interval '2 hours', idle_expires_at = now() + interval '29 days'
       WHERE id = $1`,
      [grant.grantId]
    );
    const before = await lastUse();
    await refresh(grant);
    const moved = await lastUse();
    expect(moved).toBeGreaterThan(before);
    await refresh(grant);
    expect(await lastUse()).toBe(moved);
  });

  it('refuses another DPoP key and writes at most one denied audit row per grant per minute', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const stolen = () => refresh(grant, { proof: proofOf(randomBytes(32)) });
    const deniedRows = async () =>
      (await auditRows(accountId)).filter(row => row.type === 'ai.kilo.uts.token.denied');
    expect(await stolen()).toEqual({ outcome: 'dpop_mismatch' });
    expect((await deniedRows()).at(-1)).toMatchObject({
      event: { data: { outcome: 'denied', outcomeDetail: 'dpop key mismatch' } },
    });
    expect(await stolen()).toEqual({ outcome: 'dpop_mismatch' });
    expect(await stolen()).toEqual({ outcome: 'dpop_mismatch' });
    expect(await deniedRows()).toHaveLength(1);
    await owner.query(
      `UPDATE uts.refresh_grants SET denied_audited_at = now() - interval '61 seconds' WHERE id = $1`,
      [grant.grantId]
    );
    expect(await stolen()).toEqual({ outcome: 'dpop_mismatch' });
    expect(await deniedRows()).toHaveLength(2);
  });

  it.each([
    ['another grant id', { grantId: randomUUID() }],
    ['another client', { clientId: 'kilo-other' }],
    ['a scope outside the grant', { scopes: ['gateway:chat.write'] }],
  ])('refuses %s', async (_name, overrides) => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const result = await refresh(grant, overrides);
    expect(['invalid_grant', 'invalid_scope']).toContain(result.outcome);
  });

  it('refuses a revoked grant, a blocked account, an idle-expired grant and a lost membership', async () => {
    const revoked = await firstPartyGrant(await insertAccount(owner));
    await owner.query(
      `UPDATE uts.refresh_grants SET status = 'revoked', revoked_at = now(), revoke_reason = 'admin_revoke' WHERE id = $1`,
      [revoked.grantId]
    );
    expect(await refresh(revoked)).toEqual({ outcome: 'invalid_grant' });

    const blockedAccount = await insertAccount(owner);
    const blocked = await firstPartyGrant(blockedAccount);
    await owner.query(
      `UPDATE uts.accounts SET status = 'blocked', blocked_at = now() WHERE id = $1`,
      [blockedAccount]
    );
    expect(await refresh(blocked)).toEqual({ outcome: 'invalid_grant' });

    const idle = await firstPartyGrant(await insertAccount(owner));
    await owner.query(
      `UPDATE uts.refresh_grants SET idle_expires_at = now() - interval '1 second' WHERE id = $1`,
      [idle.grantId]
    );
    expect(await refresh(idle)).toEqual({ outcome: 'invalid_grant' });

    const memberId = await insertAccount(owner);
    const orgId = randomUUID();
    await owner.query(
      `INSERT INTO uts.org_memberships (org_id, account_id, role, event_version) VALUES ($1, $2, 'member', 1)`,
      [orgId, memberId]
    );
    const fixture = await issueFirstPartyCode(memberId, { orgId });
    const input = exchangeInput(fixture);
    const exchanged = await grants.exchangeCode(input);
    expect(exchanged).toMatchObject({ outcome: 'issued', orgId });
    const orgGrant = { ...input, jkt: fixture.jkt };
    expect((await refresh(orgGrant)).outcome).toBe('issued');
    await owner.query(
      `UPDATE uts.org_memberships SET status = 'removed', removed_at = now() WHERE org_id = $1`,
      [orgId]
    );
    expect(await refresh(orgGrant)).toEqual({ outcome: 'invalid_grant' });
  });

  it('refuses to mint more than 8 tokens in one call', async () => {
    const accountId = await insertAccount(owner);
    // A code names at most 8 audiences, so the 9 scopes share one.
    const scopes = Array.from({ length: 9 }, (_, index) => `gateway:permission${index}`);
    const fixture = await issueFirstPartyCode(accountId, {}, scopes);
    expect(await grants.exchangeCode(exchangeInput(fixture))).toEqual({ outcome: 'invalid_scope' });
    const result = await grants.exchangeCode(
      exchangeInput(fixture, { scopes: scopes.slice(0, 8) })
    );
    expect(result).toMatchObject({ outcome: 'issued' });
  });
});

describe('third-party refresh rotation', () => {
  it('rotates the token, keeps the old one for a 60-second grace, and audits the rotation', async () => {
    const accountId = await insertAccount(owner);
    const family = await thirdPartyFamily(accountId);
    const first = refreshThirdParty(family.clientId, family.refreshToken);
    const rotated = await first.result;
    expect(rotated).toMatchObject({ outcome: 'issued', familyId: family.familyId });
    const tokens = await owner.query(
      `SELECT status, grace_until - rotated_at AS grace FROM uts.third_party_refresh_tokens
       WHERE family_id = $1 ORDER BY issued_at, parent_id NULLS FIRST`,
      [family.familyId]
    );
    expect(tokens.rows).toEqual([
      { status: 'rotated', grace: { minutes: 1 } },
      { status: 'active', grace: null },
    ]);
    expect((await auditRows(accountId)).at(-1)).toMatchObject({
      type: 'ai.kilo.uts.token.issued',
      event: {
        data: {
          attributes: {
            rotation: 'rotated',
            previousRefreshRef: reference(family.refreshToken),
            refreshRef: reference(first.next),
          },
        },
      },
    });

    // A retry with the old token inside its grace (a lost response) rotates the newest token.
    const retry = refreshThirdParty(family.clientId, family.refreshToken);
    expect((await retry.result).outcome).toBe('issued');
    expect((await auditRows(accountId)).at(-1)?.event.data.attributes.rotation).toBe('grace');
    expect((await refreshThirdParty(family.clientId, first.next).result).outcome).toBe('issued');
  });

  it('revokes the whole family and writes a feed entry when a rotated token returns after its grace', async () => {
    const accountId = await insertAccount(owner);
    const family = await thirdPartyFamily(accountId);
    const first = refreshThirdParty(family.clientId, family.refreshToken);
    expect((await first.result).outcome).toBe('issued');
    await owner.query(
      `UPDATE uts.third_party_refresh_tokens
       SET rotated_at = now() - interval '2 minutes', grace_until = now() - interval '1 minute'
       WHERE token_hash = $1`,
      [sha256(family.refreshToken)]
    );

    expect(await refreshThirdParty(family.clientId, family.refreshToken).result).toEqual({
      outcome: 'reuse_detected',
    });
    const stored = await owner.query(
      `SELECT family.status, family.revoke_reason,
              array_agg(DISTINCT token.status::text) AS token_statuses
       FROM uts.third_party_grant_families AS family
       JOIN uts.third_party_refresh_tokens AS token ON token.family_id = family.id
       WHERE family.id = $1 GROUP BY family.status, family.revoke_reason`,
      [family.familyId]
    );
    // The tokens keep their rows and statuses; the family's status refuses every one of them.
    expect(stored.rows).toEqual([
      { status: 'revoked', revoke_reason: 'reuse_detected', token_statuses: ['active', 'rotated'] },
    ]);
    const feed = await owner.query('SELECT kind FROM uts.revocations WHERE subject_id = $1', [
      family.familyId,
    ]);
    expect(feed.rows).toEqual([{ kind: 'third_party_family' }]);
    expect((await auditRows(accountId)).at(-1)).toMatchObject({
      type: 'ai.kilo.uts.refresh_token.reuse_detected',
      event: { data: { outcome: 'denied', outcomeDetail: 'family revoked' } },
    });
    // The newest token died with the family.
    expect(await refreshThirdParty(family.clientId, first.next).result).toEqual({
      outcome: 'invalid_grant',
    });
  });

  it('refuses another client and an unknown token', async () => {
    const accountId = await insertAccount(owner);
    const family = await thirdPartyFamily(accountId);
    expect(
      await refreshThirdParty('https://client.example.com/other', family.refreshToken).result
    ).toEqual({ outcome: 'invalid_grant' });
    expect(await refreshThirdParty(family.clientId, token()).result).toEqual({
      outcome: 'invalid_grant',
    });
  });
});

describe('revocation', () => {
  it('revokes a first-party grant and its device session once, with a feed entry and an audit row', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const revoke = (clientId = 'kilo-cli') =>
      grants.revoke({ environment, tokenHash: sha256(grant.refreshToken), clientId });
    expect(await revoke('kilo-other')).toBe('client_mismatch');
    expect(await revoke('kilo-other')).toBe('client_mismatch');
    // Caller input that the audit row's credential check would refuse is written as a hash only.
    await owner.query(
      `UPDATE uts.refresh_grants SET denied_audited_at = now() - interval '61 seconds' WHERE id = $1`,
      [grant.grantId]
    );
    expect(await revoke(`https://evil.example/kilo_rt_${token()}`)).toBe('client_mismatch');
    expect(await revoke()).toBe('revoked');
    expect(await revoke()).toBe('already_revoked');
    expect(
      await grants.revoke({ environment, tokenHash: sha256(token()), clientId: 'kilo-cli' })
    ).toBe('unknown');
    const stored = await owner.query(
      `SELECT grant_row.status, grant_row.revoke_reason, session.status AS session_status
       FROM uts.refresh_grants AS grant_row
       JOIN uts.device_sessions AS session ON session.id = grant_row.device_session_id
       WHERE grant_row.id = $1`,
      [grant.grantId]
    );
    expect(stored.rows).toEqual([
      { status: 'revoked', revoke_reason: 'sign_out', session_status: 'revoked' },
    ]);
    const feed = await owner.query('SELECT kind FROM uts.revocations WHERE subject_id = $1', [
      grant.grantId,
    ]);
    expect(feed.rows).toEqual([{ kind: 'grant' }]);
    const revokedRows = (await auditRows(accountId)).filter(
      row => row.type === 'ai.kilo.uts.grant.revoked'
    );
    expect(revokedRows.map(row => row.event.data.outcome)).toEqual(['denied', 'denied', 'success']);
    expect(revokedRows[0].event.data).toMatchObject({
      outcomeDetail: 'client mismatch',
      attributes: {
        clientId: 'kilo-cli',
        requestingClientRef: `sha256:${sha256('kilo-other').toString('base64url')}`,
        grantId: grant.grantId,
      },
    });
    expect(revokedRows[2].event.data).toMatchObject({
      classUid: OCSF_CLASS.authentication,
      activityId: 2,
      attributes: { grantId: grant.grantId, reason: 'sign_out' },
    });
  });

  it('revokes a third-party family from any of its tokens', async () => {
    const accountId = await insertAccount(owner);
    const family = await thirdPartyFamily(accountId);
    const first = refreshThirdParty(family.clientId, family.refreshToken);
    expect((await first.result).outcome).toBe('issued');
    expect(
      await grants.revoke({
        environment,
        tokenHash: sha256(family.refreshToken),
        clientId: family.clientId,
      })
    ).toBe('revoked');
    expect(await refreshThirdParty(family.clientId, first.next).result).toEqual({
      outcome: 'invalid_grant',
    });
  });

  it('revokes a family by writing its family row only, and refuses each of its tokens after', async () => {
    const accountId = await insertAccount(owner);
    const family = await thirdPartyFamily(accountId);
    const child = refreshThirdParty(family.clientId, family.refreshToken);
    expect((await child.result).outcome).toBe('issued');
    const current = refreshThirdParty(family.clientId, child.next);
    expect((await current.result).outcome).toBe('issued');
    // The first token is past its grace, the child inside it, the newest one active.
    await owner.query(
      `UPDATE uts.third_party_refresh_tokens
       SET rotated_at = now() - interval '2 minutes', grace_until = now() - interval '1 minute'
       WHERE token_hash = $1`,
      [sha256(family.refreshToken)]
    );
    // A row's `xmin` and `ctid` change with every UPDATE of it.
    const versions = async (table: string, column: string) =>
      (
        await owner.query<{ version: string }>(
          `SELECT xmin::text || ':' || ctid::text AS version FROM uts.${table}
           WHERE ${column} = $1 ORDER BY id`,
          [family.familyId]
        )
      ).rows.map(row => row.version);
    const tokensBefore = await versions('third_party_refresh_tokens', 'family_id');
    const familyBefore = await versions('third_party_grant_families', 'id');
    expect(tokensBefore).toHaveLength(3);

    const revoke = (presented: string) =>
      grants.revoke({ environment, tokenHash: sha256(presented), clientId: family.clientId });
    expect(await revoke(current.next)).toBe('revoked');
    expect(await versions('third_party_refresh_tokens', 'family_id')).toEqual(tokensBefore);
    expect(await versions('third_party_grant_families', 'id')).not.toEqual(familyBefore);

    const auditCount = (await auditRows(accountId)).length;
    for (const presented of [family.refreshToken, child.next, current.next]) {
      expect(await refreshThirdParty(family.clientId, presented).result).toEqual({
        outcome: 'invalid_grant',
      });
      expect(
        await grants.introspect({
          tokenHash: sha256(presented),
          clientId: family.clientId,
          proof: null,
        })
      ).toEqual({ outcome: 'inactive' });
      expect(await revoke(presented)).toBe('already_revoked');
    }
    // A refused token of a revoked family revokes nothing more and writes no row.
    expect(await auditRows(accountId)).toHaveLength(auditCount);
    expect(await versions('third_party_refresh_tokens', 'family_id')).toEqual(tokensBefore);
  });
});

describe('introspection', () => {
  it('answers for an active first-party grant only with its own DPoP key', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const introspect = (jkt: Buffer | null, clientId = 'kilo-cli') =>
      grants.introspect({
        tokenHash: sha256(grant.refreshToken),
        clientId,
        proof: jkt === null ? null : proofOf(jkt),
      });
    expect(await introspect(grant.jkt)).toMatchObject({
      outcome: 'active',
      kind: 'first_party',
      grantId: grant.grantId,
      subjectId: accountId,
      scopes: ['gateway:models.read', 'kilo-chat:messages.read'],
    });
    expect(await introspect(randomBytes(32))).toEqual({ outcome: 'inactive' });
    expect(await introspect(null)).toEqual({ outcome: 'inactive' });
    expect(await introspect(grant.jkt, 'kilo-other')).toEqual({ outcome: 'inactive' });
    await grants.revoke({
      environment,
      tokenHash: sha256(grant.refreshToken),
      clientId: 'kilo-cli',
    });
    expect(await introspect(grant.jkt)).toEqual({ outcome: 'inactive' });
  });

  it('answers for the active third-party token, not for a rotated one', async () => {
    const accountId = await insertAccount(owner);
    const family = await thirdPartyFamily(accountId);
    const introspect = (presented: string, jkt: Buffer | null = null) =>
      grants.introspect({
        tokenHash: sha256(presented),
        clientId: family.clientId,
        proof: jkt === null ? null : proofOf(jkt),
      });
    expect(await introspect(family.refreshToken)).toMatchObject({
      outcome: 'active',
      kind: 'third_party',
      grantId: family.familyId,
    });
    expect(await introspect(family.refreshToken, randomBytes(32))).toEqual({
      outcome: 'inactive',
    });
    const first = refreshThirdParty(family.clientId, family.refreshToken);
    await first.result;
    expect(await introspect(family.refreshToken)).toEqual({ outcome: 'inactive' });
    expect(await introspect(first.next)).toMatchObject({ outcome: 'active' });
  });

  it('writes no audit row, records the first-party proof jti and refuses it again', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const before = (await auditRows(accountId)).length;
    const input = {
      tokenHash: sha256(grant.refreshToken),
      clientId: 'kilo-cli',
      proof: proofOf(grant.jkt),
    };
    expect(await grants.introspect(input)).toMatchObject({ outcome: 'active' });
    expect(await grants.introspect(input)).toEqual({ outcome: 'dpop_replay' });
    expect(await auditRows(accountId)).toHaveLength(before);
  });
});

describe('missing inputs', () => {
  const NULL_VALUE_NOT_ALLOWED = '22004';

  it('refuses a code exchange without its PKCE challenge, and leaves the code unused', async () => {
    const accountId = await insertAccount(owner);
    const fixture = await issueFirstPartyCode(accountId);
    const input = exchangeInput(fixture);
    if (input.binding.kind !== 'first_party') throw new Error('first-party binding expected');
    expect(
      await sqlStateOf(() =>
        app.query(
          `SELECT * FROM uts.exchange_authorization_code(
             $1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11, NULL, NULL, NULL, NULL, NULL, NULL)`,
          [
            environment,
            input.codeHash,
            input.clientId,
            input.redirectUri,
            fixture.jkt,
            input.binding.proof.jti,
            input.grantId,
            input.refreshTokenHash,
            'desktop',
            device.label,
            device.platform,
          ]
        )
      )
    ).toBe(NULL_VALUE_NOT_ALLOWED);
    expect(await grants.exchangeCode(input)).toMatchObject({ outcome: 'issued' });
  });

  it('refuses a first-party refresh, revocation or introspection without the grant id or client', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const before = (await auditRows(accountId)).length;
    const tokenHash = sha256(grant.refreshToken);
    const refused = (text: string, values: unknown[]) =>
      sqlStateOf(() => app.query(text, values));
    expect(
      await refused(
        'SELECT * FROM uts.refresh_first_party($1, $2, NULL, $3, $4, $5, NULL, NULL)',
        [environment, tokenHash, 'kilo-cli', grant.jkt, randomUUID()]
      )
    ).toBe(NULL_VALUE_NOT_ALLOWED);
    expect(
      await refused(
        'SELECT * FROM uts.refresh_first_party($1, $2, $3, NULL, $4, $5, NULL, NULL)',
        [environment, tokenHash, grant.grantId, grant.jkt, randomUUID()]
      )
    ).toBe(NULL_VALUE_NOT_ALLOWED);
    expect(
      await refused('SELECT * FROM uts.revoke_refresh_token($1, $2, NULL)', [
        environment,
        tokenHash,
      ])
    ).toBe(NULL_VALUE_NOT_ALLOWED);
    expect(
      await refused('SELECT * FROM uts.introspect_refresh_token($1, NULL, $2, $3)', [
        tokenHash,
        grant.jkt,
        randomUUID(),
      ])
    ).toBe(NULL_VALUE_NOT_ALLOWED);
    expect(await auditRows(accountId)).toHaveLength(before);
    const stored = await owner.query('SELECT status FROM uts.refresh_grants WHERE id = $1', [
      grant.grantId,
    ]);
    expect(stored.rows).toEqual([{ status: 'active' }]);
  });

  it('refuses a third-party refresh without its client, and leaves the token current', async () => {
    const accountId = await insertAccount(owner);
    const family = await thirdPartyFamily(accountId);
    expect(
      await sqlStateOf(() =>
        app.query('SELECT * FROM uts.refresh_third_party($1, $2, NULL, $3, NULL, NULL)', [
          environment,
          sha256(family.refreshToken),
          sha256(token()),
        ])
      )
    ).toBe(NULL_VALUE_NOT_ALLOWED);
    expect((await refreshThirdParty(family.clientId, family.refreshToken).result).outcome).toBe(
      'issued'
    );
  });
});

describe('third-party grace window', () => {
  it.each([
    ['the token presented twice', 'first'],
    ['its child, which the grace presentation rotated', 'child'],
  ] as const)(
    'revokes the family when, after a second presentation in grace, %s comes back after the grace',
    async (_name, presentedLater) => {
      const accountId = await insertAccount(owner);
      const family = await thirdPartyFamily(accountId);
      const child = refreshThirdParty(family.clientId, family.refreshToken);
      expect((await child.result).outcome).toBe('issued');
      // The second presentation in grace (a lost response, or a stolen copy) rotates the child.
      const grace = refreshThirdParty(family.clientId, family.refreshToken);
      expect((await grace.result).outcome).toBe('issued');
      await owner.query(
        `UPDATE uts.third_party_refresh_tokens
         SET rotated_at = now() - interval '2 minutes', grace_until = now() - interval '1 minute'
         WHERE family_id = $1 AND status = 'rotated'`,
        [family.familyId]
      );
      const later = presentedLater === 'first' ? family.refreshToken : child.next;
      expect(await refreshThirdParty(family.clientId, later).result).toEqual({
        outcome: 'reuse_detected',
      });
      expect(await refreshThirdParty(family.clientId, grace.next).result).toEqual({
        outcome: 'invalid_grant',
      });
      const stored = await owner.query(
        'SELECT status, revoke_reason FROM uts.third_party_grant_families WHERE id = $1',
        [family.familyId]
      );
      expect(stored.rows).toEqual([{ status: 'revoked', revoke_reason: 'reuse_detected' }]);
    }
  );
});

describe('OAuth row maintenance', () => {
  const counts = async () => {
    const result = await app.query<{ kind: string; deleted: number }>(
      'SELECT kind, deleted FROM uts.maintain_oauth_rows()'
    );
    return Object.fromEntries(result.rows.map(row => [row.kind, row.deleted]));
  };
  const exists = async (sql: string, values: unknown[]) =>
    (await owner.query<{ found: boolean }>(`SELECT EXISTS (${sql}) AS found`, values)).rows[0]
      .found;

  it('deletes stale codes, tokens of ended families, old rotated tokens, old feed entries and proofs, nothing live', async () => {
    const accountId = await insertAccount(owner);
    const liveCode = await issueFirstPartyCode(accountId);
    const grant = await firstPartyGrant(accountId);
    const live = await thirdPartyFamily(accountId);
    await refreshThirdParty(live.clientId, live.refreshToken).result;

    // A live family whose first token was rotated 31 days ago and whose second 29 days ago.
    const aged = await thirdPartyFamily(accountId);
    const agedSecond = refreshThirdParty(aged.clientId, aged.refreshToken);
    expect((await agedSecond.result).outcome).toBe('issued');
    const agedCurrent = refreshThirdParty(aged.clientId, agedSecond.next);
    expect((await agedCurrent.result).outcome).toBe('issued');
    const age = (presented: string, issued: string, idleEnd: string, rotated: string) =>
      owner.query(
        `UPDATE uts.third_party_refresh_tokens
         SET issued_at = now() - $2::interval, idle_expires_at = now() - $3::interval,
             rotated_at = now() - $4::interval, grace_until = now() - $4::interval + interval '60 seconds'
         WHERE token_hash = $1`,
        [sha256(presented), issued, idleEnd, rotated]
      );
    await age(aged.refreshToken, '40 days', '10 days', '31 days');
    await age(agedSecond.next, '31 days', '1 day', '29 days');

    const staleCode = await issueFirstPartyCode(accountId);
    await owner.query(
      `UPDATE uts.authorization_codes
       SET created_at = now() - interval '2 hours', expires_at = now() - interval '119 minutes'
       WHERE code_hash = $1`,
      [sha256(staleCode.code)]
    );
    const ended = await thirdPartyFamily(accountId);
    await refreshThirdParty(ended.clientId, ended.refreshToken).result;
    expect(
      await grants.revoke({
        environment,
        tokenHash: sha256(ended.refreshToken),
        clientId: ended.clientId,
      })
    ).toBe('revoked');
    const staleFeed = randomUUID();
    await owner.query(
      `INSERT INTO uts.revocations (kind, subject_id, revoked_at, feed_expires_at)
       VALUES ('grant', $1, now() - interval '1 hour', now() - interval '40 minutes')`,
      [staleFeed]
    );
    const staleJti = randomUUID();
    await owner.query(
      `INSERT INTO uts.dpop_proofs (jkt, jti, expires_at) VALUES ($1, $2, now() - interval '1 second')`,
      [grant.jkt, staleJti]
    );

    const first = await counts();
    expect(Object.keys(first).sort()).toEqual([
      'authorization_codes',
      'dpop_proofs',
      'revocations',
      'rotated_refresh_tokens',
      'third_party_refresh_tokens',
    ]);
    expect(first.authorization_codes).toBeGreaterThanOrEqual(1);
    expect(first.third_party_refresh_tokens).toBeGreaterThanOrEqual(2);
    expect(first.rotated_refresh_tokens).toBeGreaterThanOrEqual(1);
    expect(first.revocations).toBeGreaterThanOrEqual(1);
    expect(first.dpop_proofs).toBeGreaterThanOrEqual(1);
    expect(await counts()).toEqual({
      authorization_codes: 0,
      dpop_proofs: 0,
      revocations: 0,
      rotated_refresh_tokens: 0,
      third_party_refresh_tokens: 0,
    });

    const code = 'SELECT 1 FROM uts.authorization_codes WHERE code_hash = $1';
    expect(await exists(code, [sha256(staleCode.code)])).toBe(false);
    expect(await exists(code, [sha256(liveCode.code)])).toBe(true);
    expect(await exists(code, [grant.codeHash])).toBe(true);
    const tokens = 'SELECT 1 FROM uts.third_party_refresh_tokens WHERE family_id = $1';
    expect(await exists(tokens, [ended.familyId])).toBe(false);
    expect(await exists(tokens, [live.familyId])).toBe(true);
    const family = 'SELECT 1 FROM uts.third_party_grant_families WHERE id = $1';
    expect(await exists(family, [ended.familyId])).toBe(true);
    const feed = 'SELECT 1 FROM uts.revocations WHERE subject_id = $1';
    expect(await exists(feed, [staleFeed])).toBe(false);
    expect(await exists(feed, [ended.familyId])).toBe(true);
    const proof = 'SELECT 1 FROM uts.dpop_proofs WHERE jkt = $1 AND jti = $2';
    expect(await exists(proof, [grant.jkt, staleJti])).toBe(false);
    if (grant.binding.kind !== 'first_party') throw new Error('first-party binding expected');
    expect(await exists(proof, [grant.jkt, grant.binding.proof.jti])).toBe(true);
    expect(
      (
        await grants.refreshFirstParty({
          environment,
          tokenHash: sha256(grant.refreshToken),
          grantId: grant.grantId,
          clientId: 'kilo-cli',
          proof: proofOf(grant.jkt),
          scopes: null,
          resources: null,
        })
      ).outcome
    ).toBe('issued');

    // The token rotated 31 days ago is gone, and its child no longer names it.
    const agedTokens = await owner.query(
      `SELECT token_hash, status, parent_id IS NULL AS first_kept
       FROM uts.third_party_refresh_tokens WHERE family_id = $1 ORDER BY issued_at`,
      [aged.familyId]
    );
    expect(agedTokens.rows).toEqual([
      { token_hash: sha256(agedSecond.next), status: 'rotated', first_kept: true },
      { token_hash: sha256(agedCurrent.next), status: 'active', first_kept: false },
    ]);
    // A deleted token is unknown and revokes nothing; a token rotated within 30 days still does.
    expect(await refreshThirdParty(aged.clientId, aged.refreshToken).result).toEqual({
      outcome: 'invalid_grant',
    });
    expect((await refreshThirdParty(aged.clientId, agedCurrent.next).result).outcome).toBe(
      'issued'
    );
    expect(await refreshThirdParty(aged.clientId, agedSecond.next).result).toEqual({
      outcome: 'reuse_detected',
    });
  });
});
