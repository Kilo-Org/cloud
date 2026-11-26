import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditEventSchema } from '@kilocode/sts-contracts';
import { UTS_SCOPE_REGISTRY, utsScopeEntry } from '@kilocode/uts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { JtiUse } from '../../src/bff/client-auth';
import { type WebSessionStore, identityStoreWebSessions } from '../../src/bff/store';
import { IdentityStore } from '../../src/db/client';
import { type GrantStore, identityStoreGrants } from '../../src/grants/store';
import {
  TestDatabase,
  insertAccount,
  insertBrowserSession,
  insertGatePass,
  sqlStateOf,
} from './harness';

/**
 * The browser-session statements of the web BFF (migration 0013) through the Worker's own
 * statements (`src/bff/store.ts`), run as the app login against the migrated schema. Sign-in
 * sessions, step-ups, device grants and subject revocations other slices write are inserted as
 * the owner.
 */

let db: TestDatabase;
let owner: pg.Client;
let sessions: WebSessionStore;
let grants: GrantStore;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  const app = await db.connect('uts_app_a');
  sessions = identityStoreWebSessions(new IdentityStore(app));
  grants = identityStoreGrants(new IdentityStore(app));
});
afterAll(() => db.drop());

const environment = 'development' as const;
const REDIRECT = 'http://localhost:3000/api/auth/uts/callback';
const SCOPE = 'uts:browser-session.read';
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const token = () => randomBytes(32).toString('base64url');
const keyJkt = randomBytes(32);
/** A fresh client assertion use: one `jti` under the test key, valid 5 minutes. */
const assertion = (jti = `jti-${randomUUID()}`): JtiUse => ({
  jkt: keyJkt,
  jti,
  expiresAt: new Date(Date.now() + 300_000),
});

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

async function sessionRow(id: string) {
  const result = await owner.query(
    `SELECT status, handle_hash, handle_issued_at, handle_auth_time, handle_amr::text[] AS handle_amr,
       token_hash, last_seen_at, idle_expires_at, revoke_reason
     FROM uts.browser_sessions WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

type WebCode = { code: string; verifier: string; challenge: string };

async function issueWebCode(accountId: string, browserSessionId: string): Promise<WebCode> {
  const code = token();
  const verifier = token();
  const challenge = sha256(verifier).toString('base64url');
  const outcome = await grants.issueCode({
    environment,
    codeHash: sha256(code),
    client: { kind: 'confidential_web', clientId: 'kilo-web' },
    accountId,
    browserSessionId,
    redirectUri: REDIRECT,
    audiences: ['uts'],
    scopes: [SCOPE],
    orgId: null,
    codeChallenge: challenge,
    authTime: new Date(Date.now() - 120_000),
    amr: ['oauth'],
  });
  expect(outcome).toEqual({ outcome: 'issued', orgRole: null });
  return { code, verifier, challenge };
}

function exchange(
  code: WebCode,
  handle: string,
  overrides: { jti?: string; redirect?: string } = {}
) {
  return sessions.exchangeCode({
    environment,
    codeHash: sha256(code.code),
    clientId: 'kilo-web',
    redirectUri: overrides.redirect ?? REDIRECT,
    codeChallenge: code.challenge,
    assertion: assertion(overrides.jti),
    handleHash: sha256(handle),
    scopes: null,
    resources: null,
  });
}

/** A signed-in account with one browser session that holds a BFF handle. */
async function webSession() {
  const accountId = await insertAccount(owner);
  const sessionId = await insertBrowserSession(owner, accountId);
  const handle = token();
  const code = await issueWebCode(accountId, sessionId);
  const issued = await exchange(code, handle);
  expect(issued.outcome).toBe('issued');
  return { accountId, sessionId, handle, code };
}

const handleInput = (handle: string) => ({
  environment,
  handleHash: sha256(handle),
  assertion: assertion(),
});

async function firstPartyGrant(accountId: string, clientClass: 'desktop' | 'mobile') {
  const device = await owner.query<{ id: string }>(
    `INSERT INTO uts.device_sessions (account_id, client_class, device_label, platform, auth_time, amr)
     VALUES ($1, $2, 'device', 'linux', now(), '{passkey}') RETURNING id`,
    [accountId, clientClass]
  );
  const grant = await owner.query<{ id: string }>(
    `INSERT INTO uts.refresh_grants (account_id, device_session_id, client_id, client_class,
       token_hash, dpop_jkt, allowed_scopes, idle_expires_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, '{kilo-api:profile.read}', now() + interval '30 days',
       now() + interval '180 days') RETURNING id`,
    [
      accountId,
      device.rows[0].id,
      clientClass === 'desktop' ? 'kilo-cli' : 'kilo-mobile',
      clientClass,
      randomBytes(32),
      randomBytes(32),
    ]
  );
  return { deviceSessionId: device.rows[0].id, grantId: grant.rows[0].id };
}

async function grantStatus(grantId: string): Promise<string> {
  const result = await owner.query<{ status: string }>(
    'SELECT status FROM uts.refresh_grants WHERE id = $1',
    [grantId]
  );
  return result.rows[0].status;
}

describe('kilo-web code exchange', () => {
  it('puts a handle on the browser session the code names and audits the tokens', async () => {
    const accountId = await insertAccount(owner);
    const sessionId = await insertBrowserSession(owner, accountId);
    const handle = token();
    const code = await issueWebCode(accountId, sessionId);
    const result = await exchange(code, handle);
    expect(result).toMatchObject({
      outcome: 'issued',
      subjectId: accountId,
      orgId: null,
      scopes: [SCOPE],
      amr: ['oauth'],
      session: { sessionId, subject: accountId, amr: ['oauth'], sso: null },
    });
    const row = await sessionRow(sessionId);
    expect(row.handle_hash).toEqual(sha256(handle));
    const audit = await auditRows(accountId);
    expect(audit.at(-1)).toMatchObject({
      type: 'ai.kilo.uts.token.issued',
      event: {
        data: {
          attributes: { clientId: 'kilo-web', sessionId, rotation: 'session_handle' },
        },
      },
    });
    expect(JSON.stringify(audit)).not.toContain(handle);
  });

  it('answers a retry with the same session and handle, and changes nothing', async () => {
    const accountId = await insertAccount(owner);
    const sessionId = await insertBrowserSession(owner, accountId);
    const handle = token();
    const code = await issueWebCode(accountId, sessionId);
    const first = await exchange(code, handle);
    const before = await sessionRow(sessionId);
    const retry = await exchange(code, handle);
    expect(first.outcome).toBe('issued');
    expect(retry.outcome).toBe('issued');
    if (first.outcome !== 'issued' || retry.outcome !== 'issued') return;
    expect(retry.session).toEqual(first.session);
    expect(retry.tokenIds).not.toEqual(first.tokenIds);
    expect(await sessionRow(sessionId)).toEqual(before);
    expect((await auditRows(accountId)).at(-1)?.event.data.attributes).toMatchObject({
      rotation: 'code_retry',
    });
  });

  it('refuses a retry with another verifier or redirect, and leaves the session live', async () => {
    const accountId = await insertAccount(owner);
    const sessionId = await insertBrowserSession(owner, accountId);
    const handle = token();
    const code = await issueWebCode(accountId, sessionId);
    expect((await exchange(code, handle)).outcome).toBe('issued');
    expect((await exchange({ ...code, challenge: token().slice(0, 43) }, handle)).outcome).toBe(
      'invalid_grant'
    );
    expect(
      (await exchange(code, handle, { redirect: 'http://localhost:3000/other' })).outcome
    ).toBe('invalid_grant');
    expect((await exchange(code, token())).outcome).toBe('invalid_grant');
    expect(
      (await sessions.read({ handleHash: sha256(handle), assertion: assertion() })).outcome
    ).toBe('active');
  });

  it('refuses an expired code without ending the session', async () => {
    const { accountId, sessionId, handle } = await webSession();
    const code = await issueWebCode(accountId, sessionId);
    await owner.query(
      `UPDATE uts.authorization_codes SET created_at = now() - interval '2 minutes',
         expires_at = now() - interval '1 minute' WHERE code_hash = $1`,
      [sha256(code.code)]
    );
    expect((await exchange(code, token())).outcome).toBe('invalid_grant');
    expect(
      (await sessions.read({ handleHash: sha256(handle), assertion: assertion() })).outcome
    ).toBe('active');
  });

  it('refuses a replayed client assertion before it reads the code', async () => {
    const accountId = await insertAccount(owner);
    const sessionId = await insertBrowserSession(owner, accountId);
    const code = await issueWebCode(accountId, sessionId);
    const jti = `jti-${randomUUID()}`;
    await sessions.read({ handleHash: sha256(token()), assertion: assertion(jti) });
    expect((await exchange(code, token(), { jti })).outcome).toBe('assertion_replay');
    const stored = await owner.query(
      'SELECT status FROM uts.authorization_codes WHERE code_hash = $1',
      [sha256(code.code)]
    );
    expect(stored.rows[0].status).toBe('issued');
  });

  it('rotates the handle on a step-up: same session, old handle dead at once', async () => {
    const { accountId, sessionId, handle } = await webSession();
    const before = await sessionRow(sessionId);
    // A passkey step-up of the session, then a new authorization in it.
    const passId = await insertGatePass(owner, accountId, 'passkey_add', sessionId);
    const passkey = await owner.query<{ id: string }>(
      `INSERT INTO uts.passkey_credentials (account_id, credential_id, public_key, backup_eligible,
         backed_up, rp_id, name, user_handle, gate_pass_id)
       VALUES ($1, $2, $3, false, false, 'localhost', 'key', $4, $5) RETURNING id`,
      [accountId, randomBytes(32), randomBytes(32), randomBytes(32), passId]
    );
    const stepUp = await owner.query<{ completed_at: Date }>(
      `INSERT INTO uts.step_ups (account_id, browser_session_id, purpose, passkey_credential_id,
         expires_at)
       VALUES ($1, $2, 'gate', $3, now() + interval '10 minutes') RETURNING completed_at`,
      [accountId, sessionId, passkey.rows[0].id]
    );
    const oldCode = await issueWebCode(accountId, sessionId);
    const newHandle = token();
    const rotated = await exchange(oldCode, newHandle);
    expect(rotated).toMatchObject({
      outcome: 'issued',
      session: { sessionId, amr: ['oauth', 'passkey'] },
    });
    if (rotated.outcome !== 'issued') return;
    expect(rotated.session.authTime).toEqual(stepUp.rows[0].completed_at);
    expect(rotated.session.issuedAt.getTime()).toBeGreaterThanOrEqual(
      before.handle_issued_at.getTime()
    );
    for (const call of [
      sessions.read({ handleHash: sha256(handle), assertion: assertion() }),
      sessions.mint({ ...handleInput(handle), scope: SCOPE, stepUp: false }),
      sessions.revokeDevice({ ...handleInput(handle), sid: randomUUID() }),
    ]) {
      expect((await call).outcome).toBe('invalid_session');
    }
    expect(
      (await sessions.read({ handleHash: sha256(newHandle), assertion: assertion() })).outcome
    ).toBe('active');
  });

  it('refuses a code whose browser session ended or a subject revocation covers', async () => {
    const { accountId, sessionId, handle } = await webSession();
    expect((await sessions.end(handleInput(handle))).outcome).toBe('ended');
    expect((await exchange(await issueCodeAfterEnd(accountId, sessionId), token())).outcome).toBe(
      'invalid_grant'
    );

    const other = await insertAccount(owner);
    const otherSession = await insertBrowserSession(owner, other);
    const code = await issueWebCode(other, otherSession);
    await owner.query(
      `INSERT INTO uts.revocations (kind, subject_id, revoked_before, feed_expires_at)
       VALUES ('subject', $1, now(), now() + interval '20 minutes')`,
      [other]
    );
    expect((await exchange(code, token())).outcome).toBe('invalid_grant');
  });

  it('keeps the code shape: a kilo-web code has no DPoP key and names a browser session', async () => {
    const accountId = await insertAccount(owner);
    expect(
      await sqlStateOf(() =>
        owner.query(
          `INSERT INTO uts.authorization_codes (code_hash, client_id, client_kind, account_id,
             redirect_uri, scopes, code_challenge, auth_time, amr, expires_at)
           VALUES ($1, 'kilo-web', 'first_party', $2, $3, '{uts:browser-session.read}', $4, now(),
             '{oauth}', now() + interval '60 seconds')`,
          [randomBytes(32), accountId, REDIRECT, token()]
        )
      )
    ).toBe('23514');
  });
});

/** A code for an ended session can still be issued by the owner; the exchange refuses it. */
async function issueCodeAfterEnd(accountId: string, sessionId: string): Promise<WebCode> {
  const code = token();
  const verifier = token();
  const challenge = sha256(verifier).toString('base64url');
  await owner.query(
    `INSERT INTO uts.authorization_codes (code_hash, client_id, client_kind, account_id,
       browser_session_id, redirect_uri, scopes, code_challenge, auth_time, amr, expires_at)
     VALUES ($1, 'kilo-web', 'first_party', $2, $3, $4, '{uts:browser-session.read}', $5, now(),
       '{oauth}', now() + interval '60 seconds')`,
    [sha256(code), accountId, sessionId, REDIRECT, challenge]
  );
  return { code, verifier, challenge };
}

describe('read and token', () => {
  it('reads a live session without moving its clocks, and refuses any other handle alike', async () => {
    const { accountId, sessionId, handle } = await webSession();
    const before = await sessionRow(sessionId);
    const read = await sessions.read({ handleHash: sha256(handle), assertion: assertion() });
    expect(read).toMatchObject({
      outcome: 'active',
      session: { sessionId, subject: accountId, amr: ['oauth'] },
    });
    expect(await sessionRow(sessionId)).toEqual(before);
    expect(
      (await sessions.read({ handleHash: sha256(token()), assertion: assertion() })).outcome
    ).toBe('invalid_session');
  });

  it('mints one token, moves the idle clock at most once per 5 minutes, and audits it', async () => {
    const { accountId, sessionId, handle } = await webSession();
    await owner.query(
      `UPDATE uts.browser_sessions SET last_seen_at = now() - interval '6 minutes',
         idle_expires_at = now() + interval '13 days' WHERE id = $1`,
      [sessionId]
    );
    const minted = await sessions.mint({ ...handleInput(handle), scope: SCOPE, stepUp: false });
    expect(minted).toMatchObject({
      outcome: 'issued',
      sessionId,
      subjectId: accountId,
      scopes: [SCOPE],
    });
    const after = await sessionRow(sessionId);
    expect(after.idle_expires_at.getTime()).toBeGreaterThan(Date.now() + 13.9 * 86_400_000);
    expect((await auditRows(accountId)).at(-1)?.event.data.attributes).toMatchObject({
      grantType: 'browser_session',
      sessionId,
    });
  });

  it('refuses a step-up scope without a recent passkey and writes nothing', async () => {
    const { accountId, handle } = await webSession();
    const before = (await auditRows(accountId)).length;
    expect(
      (await sessions.mint({ ...handleInput(handle), scope: SCOPE, stepUp: true })).outcome
    ).toBe('step_up_required');
    expect((await auditRows(accountId)).length).toBe(before);
  });

  it('refuses an idle, expired or blocked session', async () => {
    const idle = await webSession();
    await owner.query(
      `UPDATE uts.browser_sessions SET last_seen_at = now() - interval '15 days',
         idle_expires_at = now() - interval '1 day' WHERE id = $1`,
      [idle.sessionId]
    );
    const blocked = await webSession();
    await owner.query(
      `UPDATE uts.accounts SET status = 'blocked', blocked_at = now() WHERE id = $1`,
      [blocked.accountId]
    );
    for (const { handle } of [idle, blocked]) {
      expect(
        (await sessions.read({ handleHash: sha256(handle), assertion: assertion() })).outcome
      ).toBe('invalid_session');
    }
  });
});

describe('end, end-all and device revoke', () => {
  it('ends one session with one session feed entry, and repeats authoritatively', async () => {
    const { accountId, sessionId, handle } = await webSession();
    const other = await insertBrowserSession(owner, accountId);
    const ended = await sessions.end(handleInput(handle));
    expect(ended).toMatchObject({
      outcome: 'ended',
      sessionId,
      feedEntries: [
        expect.objectContaining({ kind: 'session', id: sessionId, revokedBefore: null }),
      ],
    });
    const repeat = await sessions.end(handleInput(handle));
    expect(repeat).toMatchObject({
      outcome: 'already_ended',
      feedEntries: [expect.objectContaining({ kind: 'session', id: sessionId })],
    });
    expect(await sessions.end(handleInput(token()))).toEqual({ outcome: 'invalid_session' });
    expect((await sessionRow(other)).status).toBe('active');
    const subject = await owner.query(
      `SELECT count(*)::int AS count FROM uts.revocations WHERE kind = 'subject' AND subject_id = $1`,
      [accountId]
    );
    expect(subject.rows[0].count).toBe(0);
    expect((await auditRows(accountId)).at(-1)).toMatchObject({
      type: 'ai.kilo.uts.session.revoked',
    });
  });

  it('ends every browser session of the subject and keeps its CLI and mobile grants', async () => {
    const { accountId, sessionId, handle } = await webSession();
    const second = await insertBrowserSession(owner, accountId);
    const cli = await firstPartyGrant(accountId, 'desktop');
    const mobile = await firstPartyGrant(accountId, 'mobile');
    const bystander = await webSession();

    const ended = await sessions.endAll(handleInput(handle));
    expect(ended).toMatchObject({ outcome: 'ended', ended: 2 });
    if (ended.outcome !== 'ended') return;
    expect(ended.feedEntries.map(entry => [entry.kind, entry.id]).sort()).toEqual(
      [
        ['session', sessionId],
        ['session', second],
      ].sort()
    );
    for (const id of [sessionId, second]) expect((await sessionRow(id)).status).toBe('revoked');
    expect(await grantStatus(cli.grantId)).toBe('active');
    expect(await grantStatus(mobile.grantId)).toBe('active');
    expect((await sessionRow(bystander.sessionId)).status).toBe('active');
    const subject = await owner.query(
      `SELECT count(*)::int AS count FROM uts.revocations WHERE kind = 'subject' AND subject_id = $1`,
      [accountId]
    );
    expect(subject.rows[0].count).toBe(0);

    // A repeat with the dead handle ends nothing and hands back the batch's entries.
    const repeat = await sessions.endAll(handleInput(handle));
    expect(repeat).toMatchObject({ outcome: 'ended', ended: 0 });
    if (repeat.outcome !== 'ended') return;
    expect(repeat.feedEntries.map(entry => entry.id).sort()).toEqual([sessionId, second].sort());
    expect(await sessions.endAll(handleInput(token()))).toEqual({
      outcome: 'ended',
      ended: 0,
      feedEntries: [],
    });
  });

  it('revokes one device grant by grant id or device session id, and nothing of another subject', async () => {
    const { accountId, handle, sessionId } = await webSession();
    const first = await firstPartyGrant(accountId, 'desktop');
    const second = await firstPartyGrant(accountId, 'mobile');
    const foreign = await firstPartyGrant(await insertAccount(owner), 'desktop');

    const byGrant = await sessions.revokeDevice({ ...handleInput(handle), sid: first.grantId });
    expect(byGrant).toMatchObject({
      outcome: 'ended',
      feedEntries: [expect.objectContaining({ kind: 'grant', id: first.grantId })],
    });
    // One device only: the other grant of the account still refreshes.
    expect(await grantStatus(second.grantId)).toBe('active');
    const bySession = await sessions.revokeDevice({
      ...handleInput(handle),
      sid: second.deviceSessionId,
    });
    expect(bySession).toMatchObject({
      outcome: 'ended',
      feedEntries: [expect.objectContaining({ kind: 'grant', id: second.grantId })],
    });
    expect(await sessions.revokeDevice({ ...handleInput(handle), sid: foreign.grantId })).toEqual({
      outcome: 'ended',
      feedEntries: [],
    });
    expect(await grantStatus(first.grantId)).toBe('revoked');
    expect(await grantStatus(second.grantId)).toBe('revoked');
    expect(await grantStatus(foreign.grantId)).toBe('active');
    expect((await sessionRow(sessionId)).status).toBe('active');
    // A repeat answers the same and hands back the entry for a publish retry.
    expect(
      await sessions.revokeDevice({ ...handleInput(handle), sid: first.grantId })
    ).toMatchObject({
      outcome: 'ended',
      feedEntries: [expect.objectContaining({ id: first.grantId })],
    });
  });

  it('keeps an ended session ended and its handle fixed', async () => {
    const { sessionId, handle } = await webSession();
    await sessions.end(handleInput(handle));
    expect(
      await sqlStateOf(() =>
        owner.query(
          `UPDATE uts.browser_sessions SET status = 'active', revoked_at = NULL, revoke_reason = NULL
           WHERE id = $1`,
          [sessionId]
        )
      )
    ).toBe('23514');
    expect(
      await sqlStateOf(() =>
        owner.query('UPDATE uts.browser_sessions SET handle_hash = $2 WHERE id = $1', [
          sessionId,
          randomBytes(32),
        ])
      )
    ).toBe('23514');
  });
});

describe('a handle replaced by a step-up', () => {
  it('cannot end the session, and the first code cannot bring it back, while the new handle lives', async () => {
    const { accountId, sessionId, handle, code } = await webSession();
    const newHandle = token();
    expect((await exchange(await issueWebCode(accountId, sessionId), newHandle)).outcome).toBe(
      'issued'
    );
    // A sign-out with the stale handle is not told the live session ended.
    expect(await sessions.end(handleInput(handle))).toEqual({ outcome: 'invalid_session' });
    // The first code with its own verifier no longer matches the session's handle.
    expect((await exchange(code, handle)).outcome).toBe('invalid_grant');
    expect((await sessionRow(sessionId)).status).toBe('active');
    expect(
      (await sessions.read({ handleHash: sha256(newHandle), assertion: assertion() })).outcome
    ).toBe('active');
  });
});

describe('the step-up mirror', () => {
  it('agrees with the scope registry for every registered scope and an unknown one', async () => {
    const scopes = [...Object.keys(UTS_SCOPE_REGISTRY), 'gateway:unknown.read'];
    const result = await owner.query<{ scope: string; step_up: boolean }>(
      'SELECT scope, uts.scopes_need_step_up(ARRAY[scope]) AS step_up FROM unnest($1::text[]) AS scope',
      [scopes]
    );
    expect(result.rows).toEqual(
      scopes.map(scope => ({ scope, step_up: utsScopeEntry(scope)?.stepUp === true }))
    );
  });
});

describe('legacy bridge', () => {
  const bridge = (
    accountId: string,
    overrides: Partial<Parameters<WebSessionStore['bridge']>[0]> = {}
  ) =>
    sessions.bridge({
      environment,
      accountId,
      authTime: new Date(Date.now() - 86_400_000),
      sso: null,
      assertion: assertion(),
      subjectToken: assertion(),
      handleHash: sha256(token()),
      scopes: [SCOPE],
      ...overrides,
    });

  it('creates a session with the legacy sign-in, never a recorded sign-in', async () => {
    const accountId = await insertAccount(owner);
    const authTime = new Date(Math.floor((Date.now() - 86_400_000) / 1000) * 1000);
    const result = await bridge(accountId, { authTime });
    expect(result).toMatchObject({
      outcome: 'issued',
      subjectId: accountId,
      amr: ['legacy_session'],
      session: { subject: accountId, amr: ['legacy_session'], authTime, sso: null },
    });
    if (result.outcome !== 'issued') return;
    const row = await sessionRow(result.session.sessionId);
    expect(row).toMatchObject({ token_hash: null, status: 'active' });
    const signIns = await owner.query(
      'SELECT count(*)::int AS count FROM uts.sign_ins WHERE account_id = $1',
      [accountId]
    );
    expect(signIns.rows[0].count).toBe(0);
    expect((await auditRows(accountId)).at(-1)?.event.data.attributes).toMatchObject({
      method: 'legacy_session',
      ssoVerified: false,
    });
  });

  it('carries SSO provenance only as the caller confirmed it', async () => {
    const accountId = await insertAccount(owner);
    const result = await bridge(accountId, {
      sso: { connection: 'conn_bridge', organization: 'org_bridge' },
    });
    expect(result).toMatchObject({
      outcome: 'issued',
      amr: ['legacy_session', 'sso'],
      session: { sso: { connection: 'conn_bridge', organization: 'org_bridge' } },
    });
  });

  it('refuses an unknown or blocked account, a replayed subject token and a revoked subject', async () => {
    expect((await bridge(`missing-${randomUUID()}`)).outcome).toBe('invalid_grant');

    const blocked = await insertAccount(owner);
    await owner.query(
      `UPDATE uts.accounts SET status = 'blocked', blocked_at = now() WHERE id = $1`,
      [blocked]
    );
    expect((await bridge(blocked)).outcome).toBe('invalid_grant');

    const accountId = await insertAccount(owner);
    const subjectToken = assertion();
    expect((await bridge(accountId, { subjectToken })).outcome).toBe('issued');
    expect((await bridge(accountId, { subjectToken })).outcome).toBe('invalid_grant');

    await owner.query(
      `INSERT INTO uts.revocations (kind, subject_id, revoked_before, feed_expires_at)
       VALUES ('subject', $1, now(), now() + interval '20 minutes')`,
      [accountId]
    );
    expect((await bridge(accountId)).outcome).toBe('invalid_grant');
  });

  it('refuses a replayed client assertion', async () => {
    const accountId = await insertAccount(owner);
    const used = assertion();
    expect((await bridge(accountId, { assertion: used })).outcome).toBe('issued');
    expect((await bridge(accountId, { assertion: used })).outcome).toBe('assertion_replay');
  });
});
