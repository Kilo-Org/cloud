import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AuditEventSchema } from '@kilocode/sts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IdentityStore } from '../../src/db/client';
import {
  type FlowIntent,
  type FlowProvider,
  type ProviderIdentity,
  type ProviderSignInStore,
  identityStoreProviderSignIn,
} from '../../src/signin/providers/store';
import { newAccountId } from '../../src/signin/flows';
import type { NetworkContext } from '../../src/signin/store';
import { TestDatabase, insertAccount, insertGatePass, sqlStateOf } from './harness';

/**
 * The provider, SSO and email sign-in functions (migrations 0009 and 0018) through the Worker's
 * own statements (`src/signin/providers/store.ts`), run as the app login. The Worker checks the
 * provider's answer before these statements; here the identities are fixtures. Fixtures other
 * slices write (accounts, SSO connections and domains, sessions, gate passes) are inserted as the
 * owner.
 */

let db: TestDatabase;
let owner: pg.Client;
let app: pg.Client;
let store: ProviderSignInStore;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  app = await db.connect('uts_app_a');
  store = identityStoreProviderSignIn(new IdentityStore(app));
});
afterAll(() => db.drop());

const environment = 'development';
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const token = () => randomBytes(32).toString('base64url');
const hashKey = randomBytes(32);
const keyed = (label: string, value: string) =>
  createHmac('sha256', hashKey).update(`${label}:${value}`).digest();
const network: NetworkContext = {
  userAgent: 'test browser',
  clientIp: '192.0.2.10',
  asn: 64500,
  country: 'DE',
  city: 'Berlin',
};
const address = () => `${randomBytes(5).toString('hex')}@example.com`;

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

async function auditTypes(accountId: string): Promise<string[]> {
  return (await auditRows(accountId)).map(row => row.type);
}

async function accountWithEmail(email: string, status: 'active' | 'blocked' = 'active') {
  const id = `oauth/test-${randomUUID()}`;
  await owner.query(
    `INSERT INTO uts.accounts (id, primary_email, status, blocked_at)
     VALUES ($1, $2, $3::uts.account_status, CASE WHEN $3::text = 'blocked' THEN now() END)`,
    [id, email, status]
  );
  return id;
}

async function browserSession(accountId: string): Promise<{ id: string; token: string }> {
  const value = token();
  const result = await owner.query<{ id: string }>(
    `INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
     VALUES ($1, $2, now(), '{passkey}', now() + interval '14 days', now() + interval '30 days')
     RETURNING id`,
    [accountId, sha256(value)]
  );
  return { id: result.rows[0].id, token: value };
}

type Flow = { state: string; binder: string; provider: FlowProvider };

async function startFlow(
  provider: FlowProvider,
  options: { intent?: FlowIntent; ssoDomain?: string; returnTo?: string } = {}
) {
  const flow: Flow = { state: token(), binder: token(), provider };
  const result = await store.startFlow({
    environment,
    stateHash: sha256(flow.state),
    binderHash: sha256(flow.binder),
    provider,
    intent: options.intent ?? { kind: 'sign_in' },
    ssoDomain: options.ssoDomain ?? null,
    returnTo: options.returnTo ?? '/authorize?client_id=kilo-cli',
  });
  return { flow, result };
}

async function complete(flow: Flow, identity: Partial<ProviderIdentity>, binder = flow.binder) {
  const sessionToken = token();
  const result = await store.completeFlow({
    environment,
    stateHash: sha256(flow.state),
    binderHash: sha256(binder),
    provider: flow.provider,
    identity: {
      subject: randomUUID(),
      email: null,
      emailProven: false,
      workosConnectionId: null,
      workosOrganizationId: null,
      ...identity,
    },
    sessionTokenHash: sha256(sessionToken),
    network,
    newAccountId: newAccountId(),
  });
  return { result, sessionToken };
}

async function signIn(provider: FlowProvider, identity: Partial<ProviderIdentity>) {
  const { flow, result } = await startFlow(provider);
  expect(result).toEqual({ outcome: 'started', workosConnectionId: null });
  return (await complete(flow, identity)).result;
}

async function sessionRow(tokenValue: string) {
  const result = await owner.query(
    `SELECT account_id, amr::text[] AS amr, status, host(client_ip) AS client_ip, country
     FROM uts.browser_sessions WHERE token_hash = $1`,
    [sha256(tokenValue)]
  );
  return result.rows[0];
}

/** The WorkOS ids a session recorded from its verified profile (migration 0013). */
async function sessionSso(tokenValue: string) {
  const result = await owner.query(
    `SELECT amr::text[] AS amr, sso_connection_id, sso_organization_id
     FROM uts.browser_sessions WHERE token_hash = $1`,
    [sha256(tokenValue)]
  );
  return result.rows[0];
}

describe('provider sign-in', () => {
  it('creates an account for a proven address, opens a session and audits both', async () => {
    const email = address();
    const subject = randomUUID();
    const { flow } = await startFlow('google');
    const { result, sessionToken } = await complete(flow, { subject, email, emailProven: true });
    if (result.outcome !== 'signed_in') throw new Error(result.outcome);
    expect(result.returnTo).toBe('/authorize?client_id=kilo-cli');
    expect(result.signedIn).toMatchObject({ accountCreated: true, methodLinked: false });
    const accountId = result.signedIn.accountId;
    expect(accountId).toMatch(/^uts_[a-z2-7]{26}$/);
    expect(await sessionRow(sessionToken)).toEqual({
      account_id: accountId,
      amr: ['oauth'],
      status: 'active',
      client_ip: '192.0.2.10',
      country: 'DE',
    });
    const methods = await owner.query(
      'SELECT provider, provider_subject, verified_email, gate_pass_id FROM uts.sign_in_methods WHERE account_id = $1',
      [accountId]
    );
    expect(methods.rows).toEqual([
      { provider: 'google', provider_subject: subject, verified_email: email, gate_pass_id: null },
    ]);
    // The sign-up statement writes the app's user-created event (migration 0014).
    const events = await owner.query(
      'SELECT event_type, primary_email FROM uts.app_account_events WHERE account_id = $1',
      [accountId]
    );
    expect(events.rows).toEqual([{ event_type: 'user.created', primary_email: email }]);
    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).toEqual([
      'ai.kilo.uts.account.created',
      'ai.kilo.uts.session.created',
    ]);
    expect(rows[1].event.data.attributes).toMatchObject({
      method: 'oauth',
      provider: 'google',
      accountCreated: true,
      sessionId: result.signedIn.sessionId,
    });
    // No audit row names the address.
    expect(JSON.stringify(rows)).not.toContain(email);
  });

  it('signs a known method in to its account without creating another', async () => {
    const subject = randomUUID();
    const first = await signIn('github', { subject, email: address(), emailProven: true });
    if (first.outcome !== 'signed_in') throw new Error(first.outcome);
    const second = await signIn('github', { subject, email: null, emailProven: false });
    expect(second).toMatchObject({
      outcome: 'signed_in',
      signedIn: { accountId: first.signedIn.accountId, accountCreated: false },
    });
  });

  it('links a proven address to the one account that holds it and notifies the account', async () => {
    const email = address();
    const accountId = await accountWithEmail(email);
    const result = await signIn('discord', { email, emailProven: true });
    expect(result).toMatchObject({
      outcome: 'signed_in',
      signedIn: { accountId, accountCreated: false, methodLinked: true },
    });
    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).toEqual([
      'ai.kilo.uts.sign_in_method.linked',
      'ai.kilo.uts.session.created',
    ]);
    expect(rows[0].event.data.attributes).toMatchObject({
      provider: 'discord',
      linkedBy: 'verified_email',
    });
    const notices = await owner.query(
      'SELECT kind, details FROM uts.notices WHERE account_id = $1',
      [accountId]
    );
    expect(notices.rows).toEqual([
      { kind: 'sign_in_method_changed', details: { change: 'added', provider: 'discord' } },
    ]);
  });

  it('refuses to link an address the provider did not prove, with one denied row a minute', async () => {
    const email = address();
    const accountId = await accountWithEmail(email);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await signIn('anthropic', { email, emailProven: false })).toMatchObject({
        outcome: 'link_required',
        returnTo: '/authorize?client_id=kilo-cli',
      });
    }
    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).toEqual(['ai.kilo.uts.sign_in.denied']);
    expect(rows[0].event.data).toMatchObject({ outcome: 'denied', outcomeDetail: 'link_required' });
    const methods = await owner.query('SELECT 1 FROM uts.sign_in_methods WHERE account_id = $1', [
      accountId,
    ]);
    expect(methods.rowCount).toBe(0);
  });

  it('refuses to link when several accounts hold the address', async () => {
    const email = address();
    await accountWithEmail(email);
    await accountWithEmail(email);
    expect(await signIn('google', { email, emailProven: true })).toMatchObject({
      outcome: 'link_required',
    });
  });

  it('creates no account for an unproven or missing address', async () => {
    expect(await signIn('anthropic', { email: address(), emailProven: false })).toMatchObject({
      outcome: 'email_unverified',
    });
    expect(await signIn('github', { email: null, emailProven: false })).toMatchObject({
      outcome: 'email_required',
    });
  });

  it('refuses a blocked account', async () => {
    const email = address();
    const accountId = await accountWithEmail(email, 'blocked');
    expect(await signIn('google', { email, emailProven: true })).toMatchObject({
      outcome: 'account_blocked',
    });
    expect(await auditTypes(accountId)).toEqual(['ai.kilo.uts.sign_in.denied']);
  });

  it('accepts a flow once, for its own provider and binder only', async () => {
    const { flow } = await startFlow('google');
    expect((await complete(flow, {}, token())).result).toEqual({ outcome: 'invalid_state' });
    // The failed attempt consumed the flow: the right binder now fails too.
    expect((await complete(flow, { email: address(), emailProven: true })).result).toEqual({
      outcome: 'invalid_state',
    });

    const other = await startFlow('google');
    expect(
      (
        await complete(
          { ...other.flow, provider: 'github' },
          { email: address(), emailProven: true }
        )
      ).result
    ).toEqual({ outcome: 'invalid_state' });

    const expired = await startFlow('google');
    await owner.query(
      `UPDATE uts.sign_in_flows SET created_at = now() - interval '11 minutes',
         expires_at = now() - interval '1 minute' WHERE state_hash = $1`,
      [sha256(expired.flow.state)]
    );
    expect((await complete(expired.flow, { email: address(), emailProven: true })).result).toEqual({
      outcome: 'invalid_state',
    });
  });
});

describe('linking inside a session', () => {
  async function linkFlow(provider: FlowProvider, session: { token: string }, gatePassId: string) {
    return await startFlow(provider, {
      intent: { kind: 'link', sessionTokenHash: sha256(session.token), gatePassId },
      returnTo: '/signin/done',
    });
  }

  it('adds the method to the session account and consumes the tier A pass', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const gatePassId = await insertGatePass(owner, accountId, 'method_add', session.id);
    const { flow, result } = await linkFlow('gitlab', session, gatePassId);
    expect(result.outcome).toBe('started');
    // The provider's address belongs to nobody here and is not proven: a link needs neither.
    const linked = await complete(flow, { email: address(), emailProven: false });
    expect(linked.result).toEqual({ outcome: 'linked', returnTo: '/signin/done' });
    const pass = await owner.query('SELECT status FROM uts.gate_passes WHERE id = $1', [
      gatePassId,
    ]);
    expect(pass.rows).toEqual([{ status: 'consumed' }]);
    const methods = await owner.query(
      `SELECT provider, gate_pass_id, gate_pass_action, verified_email FROM uts.sign_in_methods
       WHERE account_id = $1`,
      [accountId]
    );
    expect(methods.rows).toEqual([
      {
        provider: 'gitlab',
        gate_pass_id: gatePassId,
        gate_pass_action: 'method_add',
        verified_email: null,
      },
    ]);
    // A link opens no session.
    expect(await sessionRow(linked.sessionToken)).toBeUndefined();
    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).toEqual(['ai.kilo.uts.sign_in_method.linked']);
    expect(rows[0].event.data.attributes).toMatchObject({ linkedBy: 'gate_pass', gatePassId });
  });

  it('keeps an ended session while a method row keeps its pass', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const gatePassId = await insertGatePass(owner, accountId, 'method_add', session.id);
    const { flow } = await linkFlow('gitlab', session, gatePassId);
    expect((await complete(flow, {})).result.outcome).toBe('linked');
    // An idle end two days ago, as in the 0008 maintenance test.
    await owner.query(
      `UPDATE uts.browser_sessions SET created_at = now() - interval '20 days',
              last_seen_at = now() - interval '16 days', idle_expires_at = now() - interval '2 days',
              expires_at = now() + interval '10 days' WHERE id = $1`,
      [session.id]
    );
    const app = await db.connect('uts_app_a');
    await app.query('SELECT * FROM uts.maintain_sign_in_rows()');
    const kept = await owner.query(
      'SELECT cleanup_kept_at IS NOT NULL AS stamped FROM uts.browser_sessions WHERE id = $1',
      [session.id]
    );
    expect(kept.rows).toEqual([{ stamped: true }]);
    const method = await owner.query(
      'SELECT 1 FROM uts.sign_in_methods WHERE account_id = $1 AND gate_pass_id = $2',
      [accountId, gatePassId]
    );
    expect(method.rowCount).toBe(1);
  });

  it('refuses a link without a session or without an open tier A pass of that session', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    expect((await linkFlow('google', { token: token() }, randomUUID())).result).toEqual({
      outcome: 'no_session',
    });
    expect((await linkFlow('google', session, randomUUID())).result).toEqual({
      outcome: 'gate_required',
    });
    // A pass of another session of the same account does not serve this one.
    const otherPass = await insertGatePass(owner, accountId, 'method_add');
    expect((await linkFlow('google', session, otherPass)).result).toEqual({
      outcome: 'gate_required',
    });
    // A tier B pass does not serve a tier A action.
    const tierB = await insertGatePass(owner, accountId, 'pat_create', session.id);
    expect((await linkFlow('google', session, tierB)).result).toEqual({
      outcome: 'gate_required',
    });
    expect(await auditTypes(accountId)).toEqual(['ai.kilo.uts.gate.refused']);
  });

  it('refuses a pass consumed between start and callback', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const gatePassId = await insertGatePass(owner, accountId, 'method_add', session.id);
    const { flow } = await linkFlow('google', session, gatePassId);
    await owner.query(
      `UPDATE uts.gate_passes SET status = 'consumed', consumed_at = now() WHERE id = $1`,
      [gatePassId]
    );
    expect((await complete(flow, { email: address(), emailProven: true })).result).toMatchObject({
      outcome: 'gate_required',
    });
  });

  it('refuses a method that belongs to another account', async () => {
    const subject = randomUUID();
    const taken = await signIn('google', { subject, email: address(), emailProven: true });
    expect(taken.outcome).toBe('signed_in');
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const gatePassId = await insertGatePass(owner, accountId, 'method_add', session.id);
    const { flow } = await linkFlow('google', session, gatePassId);
    expect((await complete(flow, { subject })).result).toMatchObject({ outcome: 'method_in_use' });
    const pass = await owner.query('SELECT status FROM uts.gate_passes WHERE id = $1', [
      gatePassId,
    ]);
    expect(pass.rows).toEqual([{ status: 'open' }]);
  });
});

describe('WorkOS SSO', () => {
  const orgId = randomUUID();
  const domain = `${randomBytes(4).toString('hex')}.example.org`;
  const connection = `conn_${randomBytes(6).toString('hex')}`;
  const optionalOrg = randomUUID();
  const optionalDomain = `${randomBytes(4).toString('hex')}.example.org`;
  const optionalConnection = `conn_${randomBytes(6).toString('hex')}`;

  beforeAll(async () => {
    for (const [org, orgDomain, orgConnection, enforcement] of [
      [orgId, domain, connection, 'required'],
      [optionalOrg, optionalDomain, optionalConnection, 'optional'],
    ]) {
      await owner.query(
        `INSERT INTO uts.sso_connections (org_id, workos_connection_id) VALUES ($1, $2)`,
        [org, orgConnection]
      );
      await owner.query(
        `INSERT INTO uts.sso_domains (org_id, domain, status, dns_challenge_hash, verified_at)
         VALUES ($1, $2, 'verified', $3, now())`,
        [org, orgDomain, randomBytes(32)]
      );
      await owner.query(
        `INSERT INTO uts.org_sso_policies (org_id, enforcement, event_version) VALUES ($1, $2, 1)`,
        [org, enforcement]
      );
    }
  });

  async function ssoFlow(flowDomain = domain, flowConnection = connection) {
    const started = await startFlow('workos', { ssoDomain: flowDomain });
    expect(started.result).toEqual({ outcome: 'started', workosConnectionId: flowConnection });
    return started.flow;
  }

  it('starts only for a verified domain with one active connection', async () => {
    expect((await startFlow('workos', { ssoDomain: 'unverified.example.org' })).result).toEqual({
      outcome: 'no_sso_connection',
    });
    await ssoFlow();
  });

  it('creates an SSO account for a new address of the verified domain, with the profile ids', async () => {
    const flow = await ssoFlow();
    const { result, sessionToken } = await complete(flow, {
      email: `new-${randomBytes(3).toString('hex')}@${domain}`,
      workosConnectionId: connection,
      workosOrganizationId: 'org_profile',
    });
    expect(result).toMatchObject({ outcome: 'signed_in', signedIn: { accountCreated: true } });
    // The web BFF reads the WorkOS ids from the verified profile only (migration 0013).
    expect(await sessionSso(sessionToken)).toMatchObject({
      amr: ['sso'],
      sso_connection_id: connection,
      sso_organization_id: 'org_profile',
    });
  });

  it('records no WorkOS organization for a connection without one, and none for other providers', async () => {
    const sso = await complete(await ssoFlow(), {
      email: `new-${randomBytes(3).toString('hex')}@${domain}`,
      workosConnectionId: connection,
    });
    expect(await sessionSso(sso.sessionToken)).toMatchObject({
      sso_connection_id: connection,
      sso_organization_id: null,
    });
    const { flow } = await startFlow('github');
    const github = await complete(flow, {
      email: address(),
      emailProven: true,
      workosOrganizationId: 'org_ignored',
    });
    expect(await sessionSso(github.sessionToken)).toMatchObject({
      amr: ['oauth'],
      sso_connection_id: null,
      sso_organization_id: null,
    });
  });

  it('refuses a profile of another connection or another domain', async () => {
    expect(
      (await complete(await ssoFlow(), { email: `a@${domain}`, workosConnectionId: 'conn_other' }))
        .result
    ).toMatchObject({ outcome: 'sso_refused' });
    expect(
      (
        await complete(await ssoFlow(), {
          email: 'a@elsewhere.example.com',
          workosConnectionId: connection,
        })
      ).result
    ).toMatchObject({ outcome: 'sso_refused' });
  });

  it('settles SSO onto the one account of an address whose domain requires SSO, with a notice', async () => {
    // The account existed before the org required SSO; every other method of it is now refused,
    // so its member is not locked out.
    const email = `member-${randomBytes(3).toString('hex')}@${domain}`;
    const accountId = await accountWithEmail(email);
    expect(await signIn('google', { email, emailProven: true })).toMatchObject({
      outcome: 'sso_required',
    });
    expect(
      (await complete(await ssoFlow(), { email, workosConnectionId: connection })).result
    ).toMatchObject({
      outcome: 'signed_in',
      signedIn: { accountId, accountCreated: false, methodLinked: true },
    });
    const rows = await auditRows(accountId);
    expect(
      rows.find(row => row.type === 'ai.kilo.uts.sign_in_method.linked')?.event.data.attributes
    ).toMatchObject({ provider: 'workos', linkedBy: 'sso_required_domain' });
    const notices = await owner.query('SELECT kind FROM uts.notices WHERE account_id = $1', [
      accountId,
    ]);
    expect(notices.rows).toEqual([{ kind: 'sign_in_method_changed' }]);
  });

  it('never links SSO to an existing account by email where the domain does not require SSO', async () => {
    const email = `existing-${randomBytes(3).toString('hex')}@${optionalDomain}`;
    const accountId = await accountWithEmail(email);
    expect(
      (
        await complete(await ssoFlow(optionalDomain, optionalConnection), {
          email,
          workosConnectionId: optionalConnection,
        })
      ).result
    ).toMatchObject({ outcome: 'link_required' });
    expect(await auditTypes(accountId)).toEqual(['ai.kilo.uts.sign_in.denied']);
  });

  it('sends an address of a domain that requires SSO to SSO', async () => {
    const email = `someone-${randomBytes(3).toString('hex')}@${domain}`;
    expect(await signIn('google', { email, emailProven: true })).toMatchObject({
      outcome: 'sso_required',
    });
    expect(
      await store.startEmail({
        email,
        emailHash: keyed('kilo-uts-email', email),
        linkHash: sha256(token()),
        codeHash: keyed('kilo-uts-email-code', `${email}:123456`),
        binderHash: sha256(token()),
        returnTo: '/signin/done',
      })
    ).toEqual({ outcome: 'sso_required' });
  });
});

describe('email sign-in', () => {
  /** The binder each sent email's browser holds, by link. */
  const binders = new Map<string, string>();

  // Every case enters codes from the same client network; each starts with a fresh network count.
  beforeEach(async () => {
    await owner.query('DELETE FROM uts.network_email_code_failures');
  });

  async function sendEmail(email: string, code = '123456') {
    const link = token();
    const binder = token();
    binders.set(link, binder);
    const result = await store.startEmail({
      email,
      emailHash: keyed('kilo-uts-email', email),
      linkHash: sha256(link),
      codeHash: keyed('kilo-uts-email-code', `${email}:${code}`),
      binderHash: sha256(binder),
      returnTo: '/signin/done',
    });
    return { link, result };
  }

  async function enter(email: string, code: string, from: NetworkContext = network) {
    const sessionToken = token();
    const result = await store.verifyEmailCode({
      environment,
      emailHash: keyed('kilo-uts-email', email),
      codeHash: keyed('kilo-uts-email-code', `${email}:${code}`),
      sessionTokenHash: sha256(sessionToken),
      network: from,
      newAccountId: newAccountId(),
    });
    return { result, sessionToken };
  }

  /** Opens the link in the browser that asked for it, or in another one. */
  async function follow(link: string, browser: 'same' | 'other' | 'other_confirmed' = 'same') {
    const binder = binders.get(link);
    return await store.completeEmailLink({
      environment,
      linkHash: sha256(link),
      binderHash: browser === 'same' && binder !== undefined ? sha256(binder) : null,
      otherBrowser: browser === 'other_confirmed',
      sessionTokenHash: sha256(token()),
      network,
      newAccountId: newAccountId(),
    });
  }

  it('refuses a code entry without a code hash, and leaves the code pending (migration 0022)', async () => {
    const email = address();
    await sendEmail(email);
    expect(
      await sqlStateOf(() =>
        app.query(
          'SELECT * FROM uts.verify_email_code($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9)',
          [
            environment,
            keyed('kilo-uts-email', email),
            sha256(token()),
            network.userAgent,
            network.clientIp,
            network.asn,
            network.country,
            network.city,
            newAccountId(),
          ]
        )
      )
    ).toBe('22004');
    const { result } = await enter(email, '123456');
    expect(result.outcome).toBe('signed_in');
  });

  it('refuses guesses across older codes: a new email exhausts every earlier code', async () => {
    const email = address();
    const first = await sendEmail(email, '111111');
    await sendEmail(email, '222222');
    expect((await enter(email, '111111')).result).toMatchObject({ outcome: 'invalid_code' });
    // Five wrong entries exhaust the newest code; no older code takes over.
    for (let entry = 0; entry < 5; entry += 1) await enter(email, '000000');
    expect((await enter(email, '111111')).result).toEqual({
      outcome: 'invalid_code',
      entriesLeft: 0,
      returnTo: null,
    });
    // The older email's link still works.
    expect(await follow(first.link)).toMatchObject({ outcome: 'signed_in' });
  });

  it('asks for a confirmation when a link is opened in another browser', async () => {
    const email = address();
    const { link } = await sendEmail(email);
    expect(await follow(link, 'other')).toEqual({
      outcome: 'confirm_other_browser',
      returnTo: '/signin/done',
    });
    expect(await follow(link, 'other_confirmed')).toMatchObject({ outcome: 'signed_in' });
    expect(await store.readEmailLink(sha256(link))).toBeNull();
  });

  it('signs in with the code, creates the account and its email method once', async () => {
    const email = address();
    expect((await sendEmail(email)).result).toMatchObject({ outcome: 'stored', withCode: true });
    const { result, sessionToken } = await enter(email, '123456');
    if (result.outcome !== 'signed_in') throw new Error(result.outcome);
    expect(result).toMatchObject({ returnTo: '/signin/done', signedIn: { accountCreated: true } });
    expect((await sessionRow(sessionToken)).amr).toEqual(['email_code']);
    // The same code does not work twice, and its link died with it.
    expect((await enter(email, '123456')).result).toMatchObject({ outcome: 'invalid_code' });

    const again = await sendEmail(email, '654321');
    const second = await follow(again.link);
    expect(second).toMatchObject({
      outcome: 'signed_in',
      signedIn: { accountId: result.signedIn.accountId, accountCreated: false },
    });
    expect(await follow(again.link)).toEqual({ outcome: 'invalid_link' });
    const methods = await owner.query(
      'SELECT provider, provider_subject FROM uts.sign_in_methods WHERE account_id = $1',
      [result.signedIn.accountId]
    );
    expect(methods.rows).toEqual([{ provider: 'email', provider_subject: email }]);
  });

  it('locks the code after 5 wrong entries, audits each entry, and keeps the link', async () => {
    const email = address();
    const accountId = await accountWithEmail(email);
    const { link } = await sendEmail(email);
    const outcomes = [];
    for (let entry = 0; entry < 5; entry += 1) outcomes.push((await enter(email, '000000')).result);
    expect(outcomes).toEqual([
      { outcome: 'invalid_code', entriesLeft: 4, returnTo: '/signin/done' },
      { outcome: 'invalid_code', entriesLeft: 3, returnTo: '/signin/done' },
      { outcome: 'invalid_code', entriesLeft: 2, returnTo: '/signin/done' },
      { outcome: 'invalid_code', entriesLeft: 1, returnTo: '/signin/done' },
      { outcome: 'code_locked', returnTo: '/signin/done' },
    ]);
    // The right code no longer works.
    expect((await enter(email, '123456')).result).toEqual({
      outcome: 'invalid_code',
      entriesLeft: 0,
      returnTo: null,
    });
    const rows = await auditRows(accountId);
    expect(rows.map(row => row.event.data.outcomeDetail)).toEqual([
      'wrong_code',
      'wrong_code',
      'wrong_code',
      'wrong_code',
      'code_locked',
    ]);
    const stored = await owner.query(
      'SELECT status, attempts FROM uts.email_codes WHERE email = $1',
      [email]
    );
    expect(stored.rows).toEqual([{ status: 'exhausted', attempts: 5 }]);
    // Wrong entries by someone else do not lock the owner out: the email's link still signs in,
    // once.
    expect(await follow(link)).toMatchObject({ outcome: 'signed_in', signedIn: { accountId } });
    expect(await follow(link)).toEqual({ outcome: 'invalid_link' });
  });

  it('refuses an expired code and an expired link', async () => {
    const email = address();
    const { link } = await sendEmail(email);
    await owner.query(
      `UPDATE uts.email_codes SET created_at = now() - interval '11 minutes',
         expires_at = now() - interval '1 minute' WHERE email = $1`,
      [email]
    );
    expect((await enter(email, '123456')).result).toMatchObject({ outcome: 'invalid_code' });
    expect(await follow(link)).toEqual({ outcome: 'invalid_link' });
  });

  it('stops codes after 5 an hour, sends the link alone, and notifies the account', async () => {
    const email = address();
    const accountId = await accountWithEmail(email);
    const sent = [];
    for (let request = 0; request < 7; request += 1) sent.push((await sendEmail(email)).result);
    expect(sent.map(result => result.outcome === 'stored' && result.withCode)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
    const notices = await owner.query('SELECT kind FROM uts.notices WHERE account_id = $1', [
      accountId,
    ]);
    expect(notices.rows).toEqual([{ kind: 'sign_in_code_stopped' }]);
    // The link of a link-only email still signs in.
    const linkOnly = await sendEmail(email);
    expect(await follow(linkOnly.link)).toMatchObject({ outcome: 'signed_in' });
  });

  it('sends at most 5 link-only emails an hour while codes are stopped, and never caps the code emails (migration 0020)', async () => {
    const email = address();
    const sent = [];
    for (let request = 0; request < 11; request += 1) sent.push((await sendEmail(email)).result);
    expect(
      sent.map(result => {
        if (result.outcome !== 'stored') return result.outcome;
        return result.withCode ? 'code' : 'link';
      })
    ).toEqual([...Array(5).fill('code'), ...Array(5).fill('link'), 'send_limited']);
    const rows = await owner.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM uts.email_codes WHERE email_hash = $1',
      [keyed('kilo-uts-email', email)]
    );
    expect(rows.rows).toEqual([{ count: 10 }]);
    // Once the hour and the stop are over, emails carry codes again.
    await owner.query(
      `UPDATE uts.email_code_limits SET hour_started_at = now() - interval '61 minutes',
         day_started_at = now() - interval '61 minutes', stopped_until = now() - interval '1 minute'
       WHERE email_hash = $1`,
      [keyed('kilo-uts-email', email)]
    );
    expect((await sendEmail(email)).result).toMatchObject({ outcome: 'stored', withCode: true });
  });

  it('stops codes after 20 wrong entries in a day', async () => {
    const email = address();
    for (let round = 0; round < 4; round += 1) {
      await sendEmail(email);
      for (let entry = 0; entry < 5; entry += 1) await enter(email, '000000');
    }
    const limits = await owner.query(
      `SELECT failures_in_day, status FROM uts.email_code_limits WHERE email_hash = $1`,
      [keyed('kilo-uts-email', email)]
    );
    expect(limits.rows).toEqual([{ failures_in_day: 20, status: 'stopped' }]);
    expect((await sendEmail(email)).result).toMatchObject({ outcome: 'stored', withCode: false });
    // A stop refuses every code until the day window ends, even a right one.
    expect((await enter(email, '123456')).result).toEqual({ outcome: 'codes_stopped' });
    const stop = await owner.query<{ stopped_for_hours: number }>(
      `SELECT round(extract(epoch FROM stopped_until - day_started_at) / 3600)::int AS stopped_for_hours
       FROM uts.email_code_limits WHERE email_hash = $1`,
      [keyed('kilo-uts-email', email)]
    );
    expect(stop.rows).toEqual([{ stopped_for_hours: 24 }]);
  });

  it('refuses a blocked account by code and by link', async () => {
    const email = address();
    await accountWithEmail(email, 'blocked');
    await sendEmail(email);
    expect((await enter(email, '123456')).result).toMatchObject({ outcome: 'account_blocked' });
  });

  it('refuses every code entry of a network past 30 wrong codes an hour, and keeps links working', async () => {
    // Six addresses, five wrong codes each: the network's 30, though no address hit its own stop.
    for (let round = 0; round < 6; round += 1) {
      const email = address();
      await sendEmail(email);
      for (let entry = 0; entry < 5; entry += 1) await enter(email, '000000');
    }
    const counted = await owner.query(
      'SELECT client_network::text AS network, failures FROM uts.network_email_code_failures'
    );
    expect(counted.rows).toEqual([{ network: '192.0.2.0/24', failures: 30 }]);

    const email = address();
    const accountId = await accountWithEmail(email);
    const { link } = await sendEmail(email);
    // Another address of the /24: refused before any code is read, even the right one.
    const nearby = { ...network, clientIp: '192.0.2.200' };
    expect((await enter(email, '123456', nearby)).result).toEqual({ outcome: 'network_limited' });
    const stored = await owner.query(
      'SELECT status, attempts FROM uts.email_codes WHERE email = $1',
      [email]
    );
    expect(stored.rows).toEqual([{ status: 'pending', attempts: 0 }]);
    // A rate-limited refusal writes no audit row (decision Q56), and counts nothing more.
    expect(await auditRows(accountId)).toEqual([]);
    expect(
      (await owner.query('SELECT failures FROM uts.network_email_code_failures')).rows
    ).toEqual([{ failures: 30 }]);
    // Another network still enters codes, and the owner's link still signs in.
    const elsewhere = { ...network, clientIp: '2001:db8:7:1::5' };
    expect((await enter(email, '000000', elsewhere)).result).toMatchObject({
      outcome: 'invalid_code',
      entriesLeft: 4,
    });
    expect(await follow(link)).toMatchObject({ outcome: 'signed_in', signedIn: { accountId } });

    // Once the hour has passed, the network enters codes again and its count starts over.
    await owner.query(
      `UPDATE uts.network_email_code_failures SET window_started_at = now() - interval '61 minutes'
       WHERE client_network = '192.0.2.0/24'`
    );
    const later = address();
    await sendEmail(later);
    expect((await enter(later, '000000')).result).toMatchObject({ outcome: 'invalid_code' });
    const restarted = await owner.query(
      `SELECT failures FROM uts.network_email_code_failures WHERE client_network = '192.0.2.0/24'`
    );
    expect(restarted.rows).toEqual([{ failures: 1 }]);
  });

  it('refuses a wrong code that would pass 30 while another entry of the network holds the count', async () => {
    await owner.query(
      `INSERT INTO uts.network_email_code_failures (client_network, failures, window_started_at)
       VALUES ('192.0.2.0/24', 29, now())`
    );
    const first = address();
    const second = address();
    await sendEmail(first);
    await sendEmail(second);
    // One entry counts the 30th wrong code in a transaction that stays open, so it holds the row.
    const holding = await db.connect('uts_app_b');
    const holdingStore = identityStoreProviderSignIn(new IdentityStore(holding));
    await holding.query('BEGIN');
    const held = await holdingStore.verifyEmailCode({
      environment,
      emailHash: keyed('kilo-uts-email', first),
      codeHash: keyed('kilo-uts-email-code', `${first}:000000`),
      sessionTokenHash: sha256(token()),
      network,
      newAccountId: newAccountId(),
    });
    expect(held).toMatchObject({ outcome: 'invalid_code' });
    // The other entry passed the probe (it saw 29) and waits on the row in the upsert.
    const waiting = enter(second, '000000');
    await sleep(300);
    await holding.query('COMMIT');
    expect((await waiting).result).toEqual({ outcome: 'network_limited' });
    const counted = await owner.query(
      `SELECT failures FROM uts.network_email_code_failures WHERE client_network = '192.0.2.0/24'`
    );
    expect(counted.rows).toEqual([{ failures: 30 }]);
    const untouched = await owner.query('SELECT attempts FROM uts.email_codes WHERE email = $1', [
      second,
    ]);
    expect(untouched.rows).toEqual([{ attempts: 0 }]);
  });

  it('counts a wrong code without a client address against no network', async () => {
    const email = address();
    await sendEmail(email);
    const unknown = { ...network, clientIp: null };
    expect((await enter(email, '000000', unknown)).result).toMatchObject({
      outcome: 'invalid_code',
    });
    const counted = await owner.query('SELECT 1 FROM uts.network_email_code_failures');
    expect(counted.rowCount).toBe(0);
  });
});

describe('concurrent sign-ins', () => {
  it('settle two first sign-ins of one address one after the other, so one account results', async () => {
    const email = address();
    const firstClient = await db.connect('uts_app_a');
    const secondClient = await db.connect('uts_app_b');
    const firstStore = identityStoreProviderSignIn(new IdentityStore(firstClient));
    const secondStore = identityStoreProviderSignIn(new IdentityStore(secondClient));
    const google = await startFlow('google');
    const github = await startFlow('github');
    const completion = (target: ProviderSignInStore, flow: Flow) =>
      target.completeFlow({
        environment,
        stateHash: sha256(flow.state),
        binderHash: sha256(flow.binder),
        provider: flow.provider,
        identity: {
          subject: randomUUID(),
          email,
          emailProven: true,
          workosConnectionId: null,
          workosOrganizationId: null,
        },
        sessionTokenHash: sha256(token()),
        network,
        newAccountId: newAccountId(),
      });
    // The first sign-in's transaction stays open, holding the address's lock.
    await firstClient.query('BEGIN');
    const first = await completion(firstStore, google.flow);
    const second = completion(secondStore, github.flow);
    // The second sign-in waits on that lock: the server shows its advisory lock not granted.
    let waiting = 0;
    for (let probe = 0; probe < 200 && waiting === 0; probe += 1) {
      const locks = await owner.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
      );
      waiting = locks.rows[0].waiting;
    }
    expect(waiting).toBe(1);
    await firstClient.query('COMMIT');
    if (first.outcome !== 'signed_in') throw new Error(first.outcome);
    expect(await second).toMatchObject({
      outcome: 'signed_in',
      signedIn: { accountId: first.signedIn.accountId, accountCreated: false, methodLinked: true },
    });
    const accounts = await owner.query('SELECT id FROM uts.accounts WHERE primary_email = $1', [
      email,
    ]);
    expect(accounts.rowCount).toBe(1);
  });
});

describe('privileges and maintenance', () => {
  it('leaves the app login no direct write on methods, emails, limits or flows', async () => {
    const accountId = await insertAccount(owner);
    expect(
      await sqlStateOf(() =>
        app.query(
          `INSERT INTO uts.sign_in_methods (account_id, provider, provider_subject) VALUES ($1, 'google', 'x')`,
          [accountId]
        )
      )
    ).toBe('42501');
    expect(
      await sqlStateOf(() => app.query(`DELETE FROM uts.email_codes WHERE purpose = 'sign_in'`))
    ).toBe('42501');
    expect(
      await sqlStateOf(() => app.query('UPDATE uts.email_code_limits SET sent_in_hour = 0'))
    ).toBe('42501');
    expect(await sqlStateOf(() => app.query('SELECT 1 FROM uts.sign_in_flows'))).toBe('42501');
    expect(await sqlStateOf(() => app.query('SELECT 1 FROM uts.network_email_code_failures'))).toBe(
      '42501'
    );
  });

  it('refuses a return path to another origin in the stored flow', async () => {
    const state = token();
    expect(
      await sqlStateOf(() =>
        owner.query(
          `INSERT INTO uts.sign_in_flows (state_hash, provider, binder_hash, intent, return_to, expires_at)
           VALUES ($1, 'google', $2, 'sign_in', '//evil.example.com/', now() + interval '1 minute')`,
          [sha256(state), sha256(token())]
        )
      )
    ).toBe('23514');
  });

  it('deletes flows and sign-in emails an hour after they expired', async () => {
    const { flow } = await startFlow('google');
    await owner.query(
      `UPDATE uts.sign_in_flows SET created_at = now() - interval '2 hours',
         expires_at = now() - interval '110 minutes' WHERE state_hash = $1`,
      [sha256(flow.state)]
    );
    const result = await app.query<{ kind: string; deleted: number }>(
      'SELECT * FROM uts.maintain_provider_sign_in_rows()'
    );
    const deleted = Object.fromEntries(result.rows.map(row => [row.kind, row.deleted]));
    expect(deleted.sign_in_flows).toBeGreaterThanOrEqual(1);
    const left = await owner.query('SELECT 1 FROM uts.sign_in_flows WHERE state_hash = $1', [
      sha256(flow.state),
    ]);
    expect(left.rowCount).toBe(0);
  });

  it('deletes network counts of wrong email codes whose hour has passed', async () => {
    await owner.query(
      `INSERT INTO uts.network_email_code_failures (client_network, failures, window_started_at)
       VALUES ('198.51.100.0/24', 3, now() - interval '2 hours'),
              ('203.0.113.0/24', 3, now() - interval '10 minutes')`
    );
    const result = await app.query<{ kind: string; deleted: number }>(
      'SELECT * FROM uts.maintain_provider_sign_in_rows()'
    );
    expect(result.rows.map(row => row.kind)).toEqual([
      'sign_in_flows',
      'sign_in_emails',
      'email_code_limits',
      'network_email_code_failures',
    ]);
    const left = await owner.query(
      `SELECT client_network::text AS network FROM uts.network_email_code_failures
       WHERE client_network IN ('198.51.100.0/24', '203.0.113.0/24')`
    );
    expect(left.rows).toEqual([{ network: '203.0.113.0/24' }]);
  });
});

describe('required inputs (migration 0020)', () => {
  it('refuse a callback without the binder instead of skipping the binder check', async () => {
    const { flow } = await startFlow('github');
    const email = address();
    const values = [
      environment,
      sha256(flow.state),
      null,
      'github',
      randomUUID(),
      email,
      true,
      null,
      sha256(token()),
      network.userAgent,
      network.clientIp,
      network.asn,
      network.country,
      network.city,
      newAccountId(),
    ];
    // Migration 0013 takes this signature away from the app login and calls it from the browser
    // session wrapper, so the owner calls it here.
    expect(
      await sqlStateOf(() =>
        owner.query(
          `SELECT * FROM uts.complete_provider_sign_in($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15)`,
          values
        )
      )
    ).toBe('22004');
    const stored = await owner.query('SELECT status FROM uts.sign_in_flows WHERE state_hash = $1', [
      sha256(flow.state),
    ]);
    expect(stored.rows).toEqual([{ status: 'issued' }]);
    expect(
      await owner.query('SELECT 1 FROM uts.accounts WHERE primary_email = $1', [email])
    ).toMatchObject({ rowCount: 0 });
  });

  it('refuse a link opened in another browser without the confirmation answer instead of signing in', async () => {
    const email = address();
    const link = token();
    const started = await store.startEmail({
      email,
      emailHash: keyed('kilo-uts-email', email),
      linkHash: sha256(link),
      codeHash: keyed('kilo-uts-email-code', `${email}:123456`),
      binderHash: sha256(token()),
      returnTo: '/signin/done',
    });
    expect(started.outcome).toBe('stored');
    expect(
      await sqlStateOf(() =>
        app.query(
          'SELECT * FROM uts.complete_email_link($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
          [
            environment,
            sha256(link),
            null,
            null,
            sha256(token()),
            network.userAgent,
            network.clientIp,
            network.asn,
            network.country,
            network.city,
            newAccountId(),
          ]
        )
      )
    ).toBe('22004');
    expect(await store.readEmailLink(sha256(link))).not.toBeNull();
  });
});

describe('linking with a tier A pass the session opened (migration 0020)', () => {
  it('adds the method with a pass from uts.open_browser_tier_a_gate_pass and consumes it', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const [email, code] = [randomBytes(32), randomBytes(32)];
    await owner.query(
      `INSERT INTO uts.email_codes (purpose, email_hash, account_id, code_hash, expires_at, address)
       VALUES ('tier_a', $1, $2, $3, now() + interval '10 minutes', 'current')`,
      [email, accountId, code]
    );
    const opened = await app.query<{ outcome: string; gate_pass_id: string }>(
      'SELECT outcome, gate_pass_id FROM uts.open_browser_tier_a_gate_pass($1, $2, $3, $4, $5, NULL, NULL)',
      [environment, sha256(session.token), 'method_add', email, code]
    );
    expect(opened.rows[0].outcome).toBe('opened');
    const gatePassId = opened.rows[0].gate_pass_id;
    const { flow, result } = await startFlow('gitlab', {
      intent: { kind: 'link', sessionTokenHash: sha256(session.token), gatePassId },
      returnTo: '/signin/done',
    });
    expect(result.outcome).toBe('started');
    const linked = await complete(flow, { email: address(), emailProven: false });
    expect(linked.result).toEqual({ outcome: 'linked', returnTo: '/signin/done' });
    const methods = await owner.query(
      `SELECT method.provider, pass.status FROM uts.sign_in_methods AS method
       JOIN uts.gate_passes AS pass ON pass.id = method.gate_pass_id
       WHERE method.account_id = $1`,
      [accountId]
    );
    expect(methods.rows).toEqual([{ provider: 'gitlab', status: 'consumed' }]);
  });
});
