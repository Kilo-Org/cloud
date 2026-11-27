import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditEventSchema } from '@kilocode/sts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IdentityStore } from '../../src/db/client';
import { type DeviceContext, type GrantStore, identityStoreGrants } from '../../src/grants/store';
import {
  type DeviceExchangeInput,
  type NetworkContext,
  type SignInStore,
  type RegistrationInput,
  identityStoreSignIn,
} from '../../src/signin/store';
import { type TicketStore, identityStoreTickets } from '../../src/tickets/store';
import { TestDatabase, insertAccount, insertGatePass, sqlStateOf } from './harness';

/**
 * The sign-in, device-grant and ticket functions (migration 0008) through the Worker's own
 * statements (`src/signin/store.ts`, `src/tickets/store.ts`), run as the app login. The Worker
 * verifies WebAuthn signatures before these statements; here the passkey rows are fixtures and
 * the statements see the counter values a verified assertion would carry. Fixtures the gate and
 * sign-in slices write (accounts, sessions of other methods, gate passes) are inserted as the
 * owner.
 */

let db: TestDatabase;
let owner: pg.Client;
let app: pg.Client;
let signIn: SignInStore;
let grants: GrantStore;
let tickets: TicketStore;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  app = await db.connect('uts_app_a');
  const store = new IdentityStore(app);
  signIn = identityStoreSignIn(store);
  grants = identityStoreGrants(store);
  tickets = identityStoreTickets(store);
});
afterAll(() => db.drop());

const environment = 'development';
const RP_ID = 'localhost';
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const token = () => randomBytes(32).toString('base64url');
const network: NetworkContext = {
  userAgent: 'test browser',
  clientIp: '192.0.2.10',
  asn: 64500,
  country: 'DE',
  city: 'Berlin',
};
const device: DeviceContext = {
  label: 'Kilo CLI',
  platform: 'linux',
  clientIp: '198.51.100.7',
  asn: 64501,
  country: 'FR',
  city: 'Paris',
};

const AuditRowSchema = z.object({ event_type: z.string(), event: z.unknown() });

/** The audit rows of one account, oldest first, each checked against the audit contract. */
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

async function eventsText(accountId: string): Promise<string> {
  const result = await owner.query<{ text: string }>(
    `SELECT coalesce(string_agg(event::text, ' '), '') AS text FROM uts.audit_events WHERE account_id = $1`,
    [accountId]
  );
  return result.rows[0].text;
}

/** A browser session of another sign-in method, `authMinutesAgo` after its sign-in. */
async function browserSession(accountId: string, authMinutesAgo = 0) {
  const value = token();
  const result = await owner.query<{ id: string }>(
    `INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
     VALUES ($1, $2, now() - make_interval(mins => $3), '{oauth}', now() + interval '14 days',
             now() + interval '29 days')
     RETURNING id`,
    [accountId, sha256(value), authMinutesAgo]
  );
  return { value, hash: sha256(value), id: result.rows[0].id };
}

/**
 * A stored passkey of `accountId` with signature counter `count`, added under a pass of
 * `sessionId` when given.
 */
async function storedPasskey(accountId: string, count = 0, sessionId?: string) {
  const credentialId = randomBytes(32);
  const userHandle = randomBytes(32);
  const result = await owner.query<{ id: string }>(
    `INSERT INTO uts.passkey_credentials
       (account_id, credential_id, public_key, sign_count, backup_eligible, backed_up, rp_id, name,
        user_handle, gate_pass_id, transports)
     VALUES ($1, $2, '\\x0102', $3, true, true, $4, 'laptop', $5, $6, '{internal,hybrid}')
     RETURNING id`,
    [
      accountId,
      credentialId,
      count,
      RP_ID,
      userHandle,
      await insertGatePass(owner, accountId, 'passkey_add', sessionId),
    ]
  );
  return { id: result.rows[0].id, credentialId, userHandle };
}

async function challenge(
  ceremony: 'registration' | 'sign_in' | 'step_up',
  sessionHash: Buffer | null = null
) {
  const value = token();
  const result = await signIn.createChallenge({
    ceremony,
    challengeHash: sha256(value),
    rpId: RP_ID,
    sessionTokenHash: sessionHash,
    newUserHandle: ceremony === 'registration' ? randomBytes(32) : null,
  });
  return { hash: sha256(value), result };
}

describe('browser sessions', () => {
  it('read a live session, and move its last sight at most once per 5 minutes', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    expect(await signIn.readSession(session.hash)).toMatchObject({
      sessionId: session.id,
      accountId,
      amr: ['oauth'],
    });
    await owner.query(
      `UPDATE uts.browser_sessions SET last_seen_at = now() - interval '6 minutes',
              idle_expires_at = now() + interval '13 days' WHERE id = $1`,
      [session.id]
    );
    await signIn.readSession(session.hash);
    const seen = await owner.query<{ recent: boolean }>(
      `SELECT last_seen_at > now() - interval '1 minute' AS recent FROM uts.browser_sessions WHERE id = $1`,
      [session.id]
    );
    expect(seen.rows[0].recent).toBe(true);
  });

  it('read nothing for an unknown, revoked or expired session, or a blocked account', async () => {
    expect(await signIn.readSession(randomBytes(32))).toBeNull();
    const accountId = await insertAccount(owner);
    const revoked = await browserSession(accountId);
    await owner.query(
      `UPDATE uts.browser_sessions SET status = 'revoked', revoked_at = now(), revoke_reason = 'sign_out' WHERE id = $1`,
      [revoked.id]
    );
    expect(await signIn.readSession(revoked.hash)).toBeNull();
    const idle = await browserSession(accountId);
    await owner.query(
      `UPDATE uts.browser_sessions SET idle_expires_at = now() - interval '1 second' WHERE id = $1`,
      [idle.id]
    );
    expect(await signIn.readSession(idle.hash)).toBeNull();
    const live = await browserSession(accountId);
    await owner.query(
      `UPDATE uts.accounts SET status = 'blocked', blocked_at = now() WHERE id = $1`,
      [accountId]
    );
    expect(await signIn.readSession(live.hash)).toBeNull();
  });
});

describe('passkey sign-in', () => {
  it('creates a browser session once per challenge and writes its audit row', async () => {
    const accountId = await insertAccount(owner);
    const passkey = await storedPasskey(accountId, 4);
    const { hash, result } = await challenge('sign_in');
    expect(result).toEqual({ outcome: 'created', registration: null, passkeys: [] });

    const read = await signIn.readAssertion({
      ceremony: 'sign_in',
      challengeHash: hash,
      credentialId: passkey.credentialId,
      sessionTokenHash: null,
    });
    expect(read).toMatchObject({
      outcome: 'ok',
      passkeyId: passkey.id,
      accountId,
      signCount: 4n,
      transports: ['internal', 'hybrid'],
    });
    if (read.outcome !== 'ok') throw new Error('expected the passkey');
    expect(Buffer.from(read.userHandle).equals(passkey.userHandle)).toBe(true);

    const sessionValue = token();
    const signedIn = await signIn.completeSignIn({
      environment,
      challengeHash: hash,
      passkeyId: passkey.id,
      previousCount: 4n,
      newCount: 5n,
      backedUp: true,
      sessionTokenHash: sha256(sessionValue),
      network,
    });
    expect(signedIn).toMatchObject({
      outcome: 'signed_in',
      session: { accountId, amr: ['passkey'] },
    });
    expect(await signIn.readSession(sha256(sessionValue))).toMatchObject({
      accountId,
      amr: ['passkey'],
    });

    const again = await signIn.completeSignIn({
      environment,
      challengeHash: hash,
      passkeyId: passkey.id,
      previousCount: 5n,
      newCount: 6n,
      backedUp: true,
      sessionTokenHash: sha256(token()),
      network,
    });
    expect(again).toEqual({ outcome: 'challenge_used' });
    expect(
      await signIn.readAssertion({
        ceremony: 'sign_in',
        challengeHash: hash,
        credentialId: passkey.credentialId,
        sessionTokenHash: null,
      })
    ).toEqual({ outcome: 'unknown_challenge' });

    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).toEqual(['ai.kilo.uts.session.created']);
    expect(rows[0].event.data).toMatchObject({
      classUid: 3002,
      outcome: 'success',
      attributes: {
        method: 'passkey',
        sessionKind: 'browser',
        passkeyId: passkey.id,
        country: 'DE',
      },
    });
    expect(await eventsText(accountId)).not.toContain(sessionValue);
  });

  it('refuses a counter that moved since the read, and a blocked account', async () => {
    const accountId = await insertAccount(owner);
    const passkey = await storedPasskey(accountId, 7);
    const first = await challenge('sign_in');
    expect(
      await signIn.completeSignIn({
        environment,
        challengeHash: first.hash,
        passkeyId: passkey.id,
        previousCount: 6n,
        newCount: 8n,
        backedUp: false,
        sessionTokenHash: sha256(token()),
        network,
      })
    ).toEqual({ outcome: 'counter_conflict' });

    await owner.query(
      `UPDATE uts.accounts SET status = 'blocked', blocked_at = now() WHERE id = $1`,
      [accountId]
    );
    const second = await challenge('sign_in');
    expect(
      await signIn.completeSignIn({
        environment,
        challengeHash: second.hash,
        passkeyId: passkey.id,
        previousCount: 7n,
        newCount: 8n,
        backedUp: false,
        sessionTokenHash: sha256(token()),
        network,
      })
    ).toEqual({ outcome: 'account_inactive' });
    expect(await auditTypes(accountId)).toEqual([]);
  });

  it('refuses an account whose address is in a domain that requires SSO (migration 0009)', async () => {
    const accountId = await insertAccount(owner);
    const orgId = randomUUID();
    const domain = `${randomBytes(4).toString('hex')}.example.org`;
    await owner.query(
      `INSERT INTO uts.sso_connections (org_id, workos_connection_id) VALUES ($1, $2)`,
      [orgId, `conn_${randomBytes(6).toString('hex')}`]
    );
    await owner.query(
      `INSERT INTO uts.sso_domains (org_id, domain, status, dns_challenge_hash, verified_at)
       VALUES ($1, $2, 'verified', $3, now())`,
      [orgId, domain, randomBytes(32)]
    );
    await owner.query(
      `INSERT INTO uts.org_sso_policies (org_id, enforcement, event_version) VALUES ($1, 'required', 1)`,
      [orgId]
    );
    await owner.query('UPDATE uts.accounts SET primary_email = $2 WHERE id = $1', [
      accountId,
      `member@${domain}`,
    ]);
    const passkey = await storedPasskey(accountId, 7);
    const sessionTokenHash = sha256(token());
    const { hash } = await challenge('sign_in');
    expect(
      await signIn.completeSignIn({
        environment,
        challengeHash: hash,
        passkeyId: passkey.id,
        previousCount: 7n,
        newCount: 8n,
        backedUp: false,
        sessionTokenHash,
        network,
      })
    ).toEqual({ outcome: 'sso_required' });
    const sessions = await owner.query('SELECT 1 FROM uts.browser_sessions WHERE token_hash = $1', [
      sessionTokenHash,
    ]);
    expect(sessions.rows).toEqual([]);
    expect(await auditTypes(accountId)).toEqual(['ai.kilo.uts.sign_in.denied']);
  });

  it('knows no passkey of another relying party, and writes one refusal row per minute', async () => {
    const accountId = await insertAccount(owner);
    const passkey = await storedPasskey(accountId);
    const other = randomBytes(32);
    const { hash } = await challenge('sign_in');
    expect(
      await signIn.readAssertion({
        ceremony: 'sign_in',
        challengeHash: hash,
        credentialId: other,
        sessionTokenHash: null,
      })
    ).toEqual({ outcome: 'unknown_passkey' });
    await owner.query(
      `UPDATE uts.passkey_credentials SET rp_id = 'app.example.com' WHERE id = $1`,
      [passkey.id]
    );
    expect(
      await signIn.readAssertion({
        ceremony: 'sign_in',
        challengeHash: hash,
        credentialId: passkey.credentialId,
        sessionTokenHash: null,
      })
    ).toEqual({ outcome: 'unknown_passkey' });

    await signIn.recordPasskeyFailure(environment, passkey.id, 'sign_in', 'assertion invalid');
    await signIn.recordPasskeyFailure(environment, passkey.id, 'sign_in', 'assertion invalid');
    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).toEqual(['ai.kilo.uts.passkey.assertion_refused']);
    expect(rows[0].event.data).toMatchObject({
      outcome: 'denied',
      outcomeDetail: 'assertion invalid',
    });
  });
});

describe('passkey registration', () => {
  it('needs a session, and a tier A pass of that session that it consumes', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    expect((await challenge('registration', randomBytes(32))).result).toEqual({
      outcome: 'no_session',
    });
    const { hash, result } = await challenge('registration', session.hash);
    if (result.outcome !== 'created' || result.registration === null) {
      throw new Error('expected a registration challenge');
    }
    expect(result.registration.accountEmail).toMatch(/@example\.com$/);
    expect(result.passkeys).toEqual([]);

    const credentialId = randomBytes(32);
    const register = (challengeHash: Buffer, id = credentialId) =>
      signIn.registerPasskey({
        environment,
        challengeHash,
        sessionTokenHash: session.hash,
        credentialId: id,
        publicKey: randomBytes(77),
        signCount: 0n,
        aaguid: randomUUID(),
        transports: ['internal'],
        backupEligible: true,
        backedUp: true,
        name: 'Work laptop',
      });
    expect(await register(hash)).toEqual({ outcome: 'gate_required' });
    expect(await register(hash)).toEqual({ outcome: 'gate_required' });
    expect(await auditTypes(accountId)).toEqual(['ai.kilo.uts.gate.refused']);

    // A pass of another session of the account does not count.
    await insertGatePass(owner, accountId, 'passkey_add');
    expect(await register(hash)).toEqual({ outcome: 'gate_required' });

    const passId = await insertGatePass(owner, accountId, 'passkey_add', session.id);
    const registered = await register(hash);
    expect(registered.outcome).toBe('registered');
    if (registered.outcome !== 'registered') throw new Error('expected a passkey');
    expect(await register(hash)).toEqual({ outcome: 'challenge_used' });

    const stored = await owner.query<{ user_handle: Buffer; gate_pass_id: string; rp_id: string }>(
      'SELECT user_handle, gate_pass_id, rp_id FROM uts.passkey_credentials WHERE id = $1',
      [registered.passkeyId]
    );
    expect(stored.rows[0]).toMatchObject({ gate_pass_id: passId, rp_id: RP_ID });
    expect(stored.rows[0].user_handle.equals(Buffer.from(result.registration.userHandle))).toBe(
      true
    );
    const pass = await owner.query<{ status: string }>(
      'SELECT status FROM uts.gate_passes WHERE id = $1',
      [passId]
    );
    expect(pass.rows[0].status).toBe('consumed');
    const notice = await owner.query<{ kind: string; details: unknown }>(
      'SELECT kind, details FROM uts.notices WHERE account_id = $1',
      [accountId]
    );
    expect(notice.rows).toEqual([
      {
        kind: 'sign_in_method_changed',
        details: { change: 'passkey_added', passkeyId: registered.passkeyId },
      },
    ]);
    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).toEqual([
      'ai.kilo.uts.gate.refused',
      'ai.kilo.uts.passkey.registered',
    ]);
    expect(rows[1].event.data.attributes).toMatchObject({
      passkeyId: registered.passkeyId,
      gatePassId: passId,
      rpId: RP_ID,
    });

    // The next registration reuses the account's user handle and excludes the passkey.
    const next = await challenge('registration', session.hash);
    if (next.result.outcome !== 'created' || next.result.registration === null) {
      throw new Error('expected a registration challenge');
    }
    expect(
      Buffer.from(next.result.registration.userHandle).equals(
        Buffer.from(result.registration.userHandle)
      )
    ).toBe(true);
    expect(
      next.result.passkeys.map(item => Buffer.from(item.credentialId).equals(credentialId))
    ).toEqual([true]);
    await insertGatePass(owner, accountId, 'passkey_add', session.id);
    expect(await register(next.hash)).toEqual({ outcome: 'already_registered' });
  });

  it('takes no challenge of another session, and stops at 20 passkeys', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const other = await browserSession(accountId);
    const { hash } = await challenge('registration', other.hash);
    await insertGatePass(owner, accountId, 'passkey_add', session.id);
    const input: RegistrationInput = {
      environment,
      challengeHash: hash,
      sessionTokenHash: session.hash,
      credentialId: randomBytes(32),
      publicKey: randomBytes(77),
      signCount: 0n,
      aaguid: null,
      transports: [],
      backupEligible: false,
      backedUp: false,
      name: 'Key',
    };
    expect(await signIn.registerPasskey(input)).toEqual({ outcome: 'challenge_used' });
    for (let index = 0; index < 20; index++) await storedPasskey(accountId);
    expect((await challenge('registration', session.hash)).result).toEqual({
      outcome: 'limit_reached',
    });
  });
});

describe('passkey step-up', () => {
  it('needs a passkey of the account and records a 10-minute gate step-up of the session', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId, 30);
    expect((await challenge('step_up', session.hash)).result).toEqual({ outcome: 'no_passkey' });
    const passkey = await storedPasskey(accountId, 1);
    const { hash, result } = await challenge('step_up', session.hash);
    expect(result).toMatchObject({ outcome: 'created', registration: null });
    if (result.outcome !== 'created') throw new Error('expected a step-up challenge');
    expect(result.passkeys).toHaveLength(1);
    expect(result.passkeys[0].transports).toEqual(['internal', 'hybrid']);

    // Another session cannot use this session's challenge.
    const other = await browserSession(accountId);
    expect(
      await signIn.readAssertion({
        ceremony: 'step_up',
        challengeHash: hash,
        credentialId: passkey.credentialId,
        sessionTokenHash: other.hash,
      })
    ).toEqual({ outcome: 'unknown_challenge' });
    expect(
      await signIn.readAssertion({
        ceremony: 'step_up',
        challengeHash: hash,
        credentialId: passkey.credentialId,
        sessionTokenHash: session.hash,
      })
    ).toMatchObject({ outcome: 'ok', passkeyId: passkey.id });

    const stepUp = await signIn.completeStepUp({
      environment,
      challengeHash: hash,
      sessionTokenHash: session.hash,
      passkeyId: passkey.id,
      previousCount: 1n,
      newCount: 2n,
      backedUp: true,
    });
    expect(stepUp.outcome).toBe('completed');
    const stored = await owner.query<{ lifetime: number; purpose: string }>(
      `SELECT extract(epoch FROM expires_at - completed_at)::int AS lifetime, purpose
       FROM uts.step_ups WHERE browser_session_id = $1`,
      [session.id]
    );
    expect(stored.rows).toEqual([{ lifetime: 600, purpose: 'gate' }]);
    expect(await auditTypes(accountId)).toEqual(['ai.kilo.uts.step_up.completed']);
  });
});

/** A pending device code with a fresh device code and user code. */
async function deviceCode(scopes = ['gateway:models.read', 'kilo-chat:messages.read']) {
  const code = token();
  const userCodeHash = randomBytes(32);
  const created = await signIn.createDeviceCode({
    deviceCodeHash: sha256(code),
    userCodeHash,
    clientId: 'kilo-cli',
    scopes,
    // Each code from its own address, so the 5-pending cap per address never applies here.
    network: { ...network, clientIp: `10.${randomBytes(3).join('.')}` },
  });
  expect(created).toMatchObject({ outcome: 'created', interval: 5 });
  return { code, userCodeHash };
}

/** An address on a client network of its own, an IPv4 /24 no other test uses. */
function ownNetwork(): (host: number) => string {
  const [first, second] = randomBytes(2);
  return host => `10.${first}.${second}.${host}`;
}

/** `count` wrong user codes entered by the session from `clientIp`. */
async function enterWrongCodes(sessionHash: Buffer, clientIp: string, count: number) {
  for (let attempt = 0; attempt < count; attempt++) {
    const read = await signIn.readDeviceCode({
      userCodeHash: randomBytes(32),
      sessionTokenHash: sessionHash,
      clientIp,
    });
    expect(read.outcome).toBe('unknown_code');
  }
}

function exchangeInput(
  code: string,
  overrides: Partial<DeviceExchangeInput> = {}
): DeviceExchangeInput {
  return {
    environment,
    deviceCodeHash: sha256(code),
    clientId: 'kilo-cli',
    clientClass: 'desktop',
    proof: { jkt: randomBytes(32), jti: randomUUID() },
    grantId: randomUUID(),
    refreshTokenHash: sha256(token()),
    device,
    scopes: null,
    resources: null,
    ...overrides,
  };
}

describe('device grant', () => {
  it('stores a pending 10-minute code that names no account and writes no audit row', async () => {
    const { userCodeHash } = await deviceCode();
    const stored = await owner.query<{
      lifetime: number;
      status: string;
      account_id: string | null;
    }>(
      `SELECT extract(epoch FROM expires_at - created_at)::int AS lifetime, status, account_id
       FROM uts.device_codes WHERE user_code_hash = $1`,
      [userCodeHash]
    );
    expect(stored.rows).toEqual([{ lifetime: 600, status: 'pending', account_id: null }]);
    expect(
      await signIn.createDeviceCode({
        deviceCodeHash: sha256(token()),
        userCodeHash,
        clientId: 'kilo-cli',
        scopes: ['gateway:models.read'],
        network,
      })
    ).toEqual({ outcome: 'user_code_taken' });
  });

  it('shows a pending code only to a live session, and allows an account 10 wrong codes per hour over all its sessions', async () => {
    const accountId = await insertAccount(owner);
    const first = await browserSession(accountId);
    const second = await browserSession(accountId);
    const { userCodeHash } = await deviceCode();
    const read = (sessionHash: Buffer, clientIp: string | null = ownNetwork()(1)) =>
      signIn.readDeviceCode({ userCodeHash, sessionTokenHash: sessionHash, clientIp });
    expect(await read(randomBytes(32))).toEqual({ outcome: 'no_session' });
    expect(await read(first.hash)).toMatchObject({
      outcome: 'pending',
      clientId: 'kilo-cli',
      scopes: ['gateway:models.read', 'kilo-chat:messages.read'],
      userAgent: 'test browser',
      country: 'DE',
      city: 'Berlin',
    });
    // Each from its own network, so only the account's count can stop them.
    await enterWrongCodes(first.hash, ownNetwork()(1), 5);
    await enterWrongCodes(second.hash, ownNetwork()(1), 4);
    const withoutAddress = await signIn.readDeviceCode({
      userCodeHash: randomBytes(32),
      sessionTokenHash: second.hash,
      clientIp: null,
    });
    expect(withoutAddress.outcome).toBe('unknown_code');
    const third = await browserSession(accountId);
    expect((await read(third.hash)).outcome).toBe('too_many_attempts');
    expect(
      await signIn.decideDeviceCode({
        environment,
        userCodeHash,
        sessionTokenHash: third.hash,
        clientIp: ownNetwork()(1),
        source: 'typed',
        approve: true,
      })
    ).toBe('too_many_attempts');
    const counted = await owner.query<{ failures: number }>(
      'SELECT failures FROM uts.account_user_code_failures WHERE account_id = $1',
      [accountId]
    );
    expect(counted.rows).toEqual([{ failures: 10 }]);
    await owner.query(
      `UPDATE uts.account_user_code_failures SET window_started_at = now() - interval '61 minutes'
       WHERE account_id = $1`,
      [accountId]
    );
    expect((await read(third.hash)).outcome).toBe('pending');
  });

  it('allows a client network 30 wrong codes per hour over all its accounts', async () => {
    const host = ownNetwork();
    const { userCodeHash } = await deviceCode();
    // Four accounts, none at its own limit of 10, spend the network's 30 from three addresses.
    for (const [index, count] of [9, 9, 9, 3].entries()) {
      const session = await browserSession(await insertAccount(owner));
      await enterWrongCodes(session.hash, host(index + 1), count);
    }
    const fresh = await browserSession(await insertAccount(owner));
    const read = (clientIp: string) =>
      signIn.readDeviceCode({ userCodeHash, sessionTokenHash: fresh.hash, clientIp });
    expect((await read(host(200))).outcome).toBe('too_many_attempts');
    expect((await read(ownNetwork()(200))).outcome).toBe('pending');
    const counted = await owner.query<{ network: string; failures: number }>(
      `SELECT client_network::text AS network, failures FROM uts.network_user_code_failures
       WHERE client_network = $1::inet`,
      [`${host(0)}/24`]
    );
    expect(counted.rows).toEqual([{ network: `${host(0)}/24`, failures: 30 }]);
    const networks = await owner.query<{ v4: string; v6: string; none: string | null }>(
      `SELECT uts.client_network('192.0.2.77')::text AS v4,
              uts.client_network('2001:db8:1:2::5')::text AS v6,
              uts.client_network(NULL)::text AS none`
    );
    expect(networks.rows).toEqual([{ v4: '192.0.2.0/24', v6: '2001:db8:1::/48', none: null }]);
  });

  it('answers pending, then slow_down for a poll inside the interval, which grows by 5 seconds', async () => {
    const { code } = await deviceCode();
    expect((await signIn.exchangeDeviceCode(exchangeInput(code))).outcome).toBe(
      'authorization_pending'
    );
    expect((await signIn.exchangeDeviceCode(exchangeInput(code))).outcome).toBe('slow_down');
    const stored = await owner.query<{ poll_interval_seconds: number }>(
      'SELECT poll_interval_seconds FROM uts.device_codes WHERE device_code_hash = $1',
      [sha256(code)]
    );
    expect(stored.rows[0].poll_interval_seconds).toBe(10);
  });

  it('approves only with a recent sign-in or a passkey step-up of the session (tier B)', async () => {
    const accountId = await insertAccount(owner);
    const stale = await browserSession(accountId, 20);
    const { code, userCodeHash } = await deviceCode();
    const decide = (sessionHash: Buffer, hash = userCodeHash) =>
      signIn.decideDeviceCode({
        environment,
        userCodeHash: hash,
        sessionTokenHash: sessionHash,
        clientIp: network.clientIp,
        source: 'typed',
        approve: true,
      });
    expect(await decide(stale.hash)).toBe('gate_required');
    expect(await auditTypes(accountId)).toEqual(['ai.kilo.uts.gate.refused']);

    const passkey = await storedPasskey(accountId);
    await owner.query(
      `INSERT INTO uts.step_ups (account_id, browser_session_id, purpose, passkey_credential_id, expires_at)
       VALUES ($1, $2, 'gate', $3, now() + interval '10 minutes')`,
      [accountId, stale.id, passkey.id]
    );
    expect(await decide(stale.hash)).toBe('approved');
    expect(await decide(stale.hash)).toBe('unknown_code');

    const approved = await owner.query<{
      status: string;
      amr: string;
      satisfied_by: string;
      pass_status: string;
      tier: string;
    }>(
      `SELECT code.status, code.amr::text, pass.satisfied_by::text, pass.status AS pass_status, pass.tier
       FROM uts.device_codes AS code JOIN uts.gate_passes AS pass ON pass.id = code.gate_pass_id
       WHERE code.device_code_hash = $1`,
      [sha256(code)]
    );
    expect(approved.rows).toEqual([
      {
        status: 'approved',
        amr: '{oauth,passkey,device_grant}',
        satisfied_by: '{passkey}',
        pass_status: 'consumed',
        tier: 'b',
      },
    ]);
    const notices = await owner.query<{ kind: string; details: unknown }>(
      'SELECT kind, details FROM uts.notices WHERE account_id = $1',
      [accountId]
    );
    expect(notices.rows).toEqual([
      {
        kind: 'device_sign_in_approved',
        details: { clientId: 'kilo-cli', country: 'DE', city: 'Berlin' },
      },
    ]);

    const fresh = await browserSession(accountId);
    const second = await deviceCode();
    expect(await decide(fresh.hash, second.userCodeHash)).toBe('approved');
    const pass = await owner.query<{ satisfied_by: string }>(
      `SELECT pass.satisfied_by::text FROM uts.device_codes AS code
       JOIN uts.gate_passes AS pass ON pass.id = code.gate_pass_id WHERE code.device_code_hash = $1`,
      [sha256(second.code)]
    );
    expect(pass.rows[0].satisfied_by).toBe('{recent_sign_in}');
  });

  it('needs a passkey step-up for a code that came in a link, whatever the sign-in age', async () => {
    const accountId = await insertAccount(owner);
    const fresh = await browserSession(accountId);
    const { code, userCodeHash } = await deviceCode();
    const decideLinked = () =>
      signIn.decideDeviceCode({
        environment,
        userCodeHash,
        sessionTokenHash: fresh.hash,
        clientIp: network.clientIp,
        source: 'link',
        approve: true,
      });
    expect(await decideLinked()).toBe('gate_required');
    const refusals = await auditRows(accountId);
    expect(refusals.map(row => row.type)).toEqual(['ai.kilo.uts.gate.refused']);
    expect(JSON.stringify(refusals[0].event)).toContain('passkey check required for a linked code');

    const passkey = await storedPasskey(accountId);
    await owner.query(
      `INSERT INTO uts.step_ups (account_id, browser_session_id, purpose, passkey_credential_id, expires_at)
       VALUES ($1, $2, 'gate', $3, now() + interval '10 minutes')`,
      [accountId, fresh.id, passkey.id]
    );
    expect(await decideLinked()).toBe('approved');
    const pass = await owner.query<{ satisfied_by: string }>(
      `SELECT pass.satisfied_by::text FROM uts.device_codes AS code
       JOIN uts.gate_passes AS pass ON pass.id = code.gate_pass_id WHERE code.device_code_hash = $1`,
      [sha256(code)]
    );
    expect(pass.rows[0].satisfied_by).toBe('{passkey}');
  });

  it('issues a DPoP-bound desktop grant once, lets the same poll retry, and revokes on any other reuse', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const { code, userCodeHash } = await deviceCode();
    expect(
      await signIn.decideDeviceCode({
        environment,
        userCodeHash,
        sessionTokenHash: session.hash,
        clientIp: network.clientIp,
        source: 'typed',
        approve: true,
      })
    ).toBe('approved');

    const jkt = randomBytes(32);
    const grantId = randomUUID();
    const first = exchangeInput(code, { proof: { jkt, jti: randomUUID() }, grantId });
    const issued = await signIn.exchangeDeviceCode(first);
    expect(issued).toMatchObject({
      outcome: 'issued',
      subjectId: accountId,
      amr: ['oauth', 'device_grant'],
      scopes: ['gateway:models.read', 'kilo-chat:messages.read'],
    });
    if (issued.outcome !== 'issued') throw new Error('expected tokens');
    expect(issued.tokenIds).toHaveLength(2);
    expect(Math.round((issued.refreshExpiresAt.getTime() - Date.now()) / 86_400_000)).toBe(30);

    const grant = await owner.query<{
      client_class: string;
      idle: number;
      max: number;
      platform: string;
    }>(
      `SELECT grant_row.client_class,
              round(extract(epoch FROM grant_row.idle_expires_at - grant_row.created_at) / 86400)::int AS idle,
              round(extract(epoch FROM grant_row.expires_at - grant_row.created_at) / 86400)::int AS max,
              session.platform
       FROM uts.refresh_grants AS grant_row
       JOIN uts.device_sessions AS session ON session.id = grant_row.device_session_id
       WHERE grant_row.id = $1 AND grant_row.dpop_jkt = $2`,
      [grantId, jkt]
    );
    expect(grant.rows).toEqual([
      { client_class: 'desktop', idle: 30, max: 180, platform: 'linux' },
    ]);

    // The same proof again is a replay; a fresh proof of the same key retries.
    expect((await signIn.exchangeDeviceCode(first)).outcome).toBe('dpop_replay');
    const retry = exchangeInput(code, { proof: { jkt, jti: randomUUID() }, grantId });
    expect((await signIn.exchangeDeviceCode(retry)).outcome).toBe('issued');
    const hash = await owner.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM uts.refresh_grants WHERE id = $1',
      [grantId]
    );
    expect(hash.rows[0].token_hash.equals(retry.refreshTokenHash)).toBe(true);

    // Another key presenting the consumed code revokes the grant.
    expect((await signIn.exchangeDeviceCode(exchangeInput(code, { grantId }))).outcome).toBe(
      'invalid_grant'
    );
    const revoked = await owner.query<{ status: string; feed: number }>(
      `SELECT grant_row.status,
              (SELECT count(*)::int FROM uts.revocations WHERE kind = 'grant' AND subject_id = $1) AS feed
       FROM uts.refresh_grants AS grant_row WHERE grant_row.id = $1::uuid`,
      [grantId]
    );
    expect(revoked.rows).toEqual([{ status: 'revoked', feed: 1 }]);
    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).toEqual([
      'ai.kilo.uts.device_code.approved',
      'ai.kilo.uts.grant.created',
      'ai.kilo.uts.token.issued',
      'ai.kilo.uts.device_code.reused',
    ]);
    expect(rows[1].event.data.attributes).toMatchObject({
      grantType: 'device_code',
      grantId,
      tokenRefs: issued.tokenIds,
    });
    expect(rows[2].event.data.attributes).toMatchObject({ rotation: 'device_code_retry' });
  });

  it('answers access_denied for a denied code and expired_token for an expired one', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const denied = await deviceCode();
    expect(
      await signIn.decideDeviceCode({
        environment,
        userCodeHash: denied.userCodeHash,
        sessionTokenHash: session.hash,
        clientIp: network.clientIp,
        source: 'typed',
        approve: false,
      })
    ).toBe('denied');
    expect((await signIn.exchangeDeviceCode(exchangeInput(denied.code))).outcome).toBe(
      'access_denied'
    );
    expect(await auditTypes(accountId)).toEqual(['ai.kilo.uts.device_code.denied']);

    const expired = await deviceCode();
    await owner.query(
      `UPDATE uts.device_codes SET created_at = now() - interval '11 minutes',
              expires_at = now() - interval '1 minute' WHERE device_code_hash = $1`,
      [sha256(expired.code)]
    );
    expect((await signIn.exchangeDeviceCode(exchangeInput(expired.code))).outcome).toBe(
      'expired_token'
    );
    expect((await signIn.exchangeDeviceCode(exchangeInput(token()))).outcome).toBe('invalid_grant');
  });
});

/**
 * A first-party grant made through a code exchange (migration 0004), and how to present it; bound
 * to `orgId` when given, whose membership the caller inserted.
 */
async function firstPartyGrant(
  accountId: string,
  scopes = ['gateway:models.read', 'kilo-chat:messages.read'],
  orgId: string | null = null
) {
  const code = token();
  const verifier = token();
  const challengeValue = sha256(verifier).toString('base64url');
  const jkt = randomBytes(32);
  expect(
    await grants.issueCode({
      environment,
      codeHash: sha256(code),
      client: { kind: 'first_party', clientId: 'kilo-cli', dpopJkt: jkt },
      accountId,
      browserSessionId: null,
      redirectUri: 'http://127.0.0.1:4100/callback',
      audiences: [...new Set(scopes.map(scope => scope.split(':')[0]))],
      scopes,
      orgId,
      codeChallenge: challengeValue,
      authTime: new Date(),
      amr: ['passkey'],
    })
  ).toEqual({ outcome: 'issued', orgRole: orgId === null ? null : expect.any(String) });
  const refreshToken = `kilo_rt_${token()}`;
  const grantId = randomUUID();
  const exchanged = await grants.exchangeCode({
    environment,
    codeHash: sha256(code),
    clientId: 'kilo-cli',
    redirectUri: 'http://127.0.0.1:4100/callback',
    codeChallenge: challengeValue,
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
  expect(exchanged.outcome).toBe('issued');
  return { refreshToken, grantId, jkt };
}

describe('one-time tickets', () => {
  it('mint from a grant with its DPoP key, once per proof, for an audience of its scopes', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const ticket = token();
    const issue = (overrides: Partial<Parameters<TicketStore['issue']>[0]> = {}) =>
      tickets.issue({
        environment,
        tokenHash: sha256(grant.refreshToken),
        grantId: grant.grantId,
        clientId: 'kilo-cli',
        proof: { jkt: grant.jkt, jti: randomUUID() },
        ticketHash: sha256(token()),
        purpose: 'stream',
        audience: 'kilo-chat',
        resource: 'session-1',
        ...overrides,
      });
    const issued = await issue({ ticketHash: sha256(ticket) });
    expect(issued.outcome).toBe('issued');
    if (issued.outcome !== 'issued') throw new Error('expected a ticket');
    expect(Math.round((issued.expiresAt.getTime() - Date.now()) / 1000)).toBeLessThanOrEqual(60);

    const replayed = { jkt: grant.jkt, jti: randomUUID() };
    expect((await issue({ proof: replayed })).outcome).toBe('issued');
    expect(await issue({ proof: replayed })).toEqual({ outcome: 'dpop_replay' });
    expect(await issue({ proof: { jkt: randomBytes(32), jti: randomUUID() } })).toEqual({
      outcome: 'dpop_mismatch',
    });
    expect(await issue({ audience: 'session-ingest' })).toEqual({ outcome: 'invalid_target' });
    expect(await issue({ clientId: 'kilo-mobile' })).toEqual({ outcome: 'invalid_grant' });
    expect(await issue({ tokenHash: sha256(token()) })).toEqual({ outcome: 'invalid_grant' });

    const types = await auditTypes(accountId);
    expect(types.filter(type => type === 'ai.kilo.uts.ticket.issued')).toHaveLength(2);
    expect(types.filter(type => type === 'ai.kilo.uts.ticket.denied')).toHaveLength(1);
    expect(await eventsText(accountId)).not.toContain(ticket);
  });

  it('redeem once for their audience; a second use and a wrong audience answer unknown', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const ticket = token();
    const issued = await tickets.issue({
      environment,
      tokenHash: sha256(grant.refreshToken),
      grantId: grant.grantId,
      clientId: 'kilo-cli',
      proof: { jkt: grant.jkt, jti: randomUUID() },
      ticketHash: sha256(ticket),
      purpose: 'terminal',
      audience: 'gateway',
      resource: null,
    });
    expect(issued.outcome).toBe('issued');

    const redeem = (hash: Buffer, audience: string) =>
      tickets.redeem(environment, hash, audience, 'terminal', null);
    expect(await redeem(sha256(ticket), 'kilo-chat')).toEqual({ outcome: 'unknown' });
    expect(await redeem(sha256(ticket), 'kilo-chat')).toEqual({ outcome: 'unknown' });
    expect(await redeem(sha256(ticket), 'gateway')).toEqual({
      outcome: 'redeemed',
      accountId,
      purpose: 'terminal',
      resource: null,
      orgId: null,
      grantId: grant.grantId,
      clientId: 'kilo-cli',
    });
    expect(await redeem(sha256(ticket), 'gateway')).toEqual({ outcome: 'unknown' });
    expect(await redeem(sha256(ticket), 'gateway')).toEqual({ outcome: 'unknown' });
    expect(await redeem(sha256(token()), 'gateway')).toEqual({ outcome: 'unknown' });
    const types = (await auditTypes(accountId)).filter(type =>
      type.startsWith('ai.kilo.uts.ticket.')
    );
    expect(types).toEqual([
      'ai.kilo.uts.ticket.issued',
      'ai.kilo.uts.ticket.denied',
      'ai.kilo.uts.ticket.redeemed',
      'ai.kilo.uts.ticket.reused',
    ]);
  });

  it('redeem only for the purpose and resource they were minted for, and stay usable after a mismatch', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const ticket = token();
    const issued = await tickets.issue({
      environment,
      tokenHash: sha256(grant.refreshToken),
      grantId: grant.grantId,
      clientId: 'kilo-cli',
      proof: { jkt: grant.jkt, jti: randomUUID() },
      ticketHash: sha256(ticket),
      purpose: 'terminal',
      audience: 'gateway',
      resource: 'box-1',
    });
    expect(issued.outcome).toBe('issued');
    for (const [purpose, resource] of [
      ['stream', 'box-1'],
      ['terminal', 'box-2'],
      ['terminal', null],
    ] as const) {
      expect(
        await tickets.redeem(environment, sha256(ticket), 'gateway', purpose, resource)
      ).toEqual({ outcome: 'unknown' });
    }
    expect(
      await tickets.redeem(environment, sha256(ticket), 'gateway', 'terminal', 'box-1')
    ).toMatchObject({ outcome: 'redeemed', purpose: 'terminal', resource: 'box-1' });
    // One denied row a minute for the three mismatches, as for a wrong audience.
    const types = (await auditTypes(accountId)).filter(type =>
      type.startsWith('ai.kilo.uts.ticket.')
    );
    expect(types).toEqual([
      'ai.kilo.uts.ticket.issued',
      'ai.kilo.uts.ticket.denied',
      'ai.kilo.uts.ticket.redeemed',
    ]);
  });

  it('redeem nothing once the ticket expired or its grant ended', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const mint = async () => {
      const ticket = token();
      const issued = await tickets.issue({
        environment,
        tokenHash: sha256(grant.refreshToken),
        grantId: grant.grantId,
        clientId: 'kilo-cli',
        proof: { jkt: grant.jkt, jti: randomUUID() },
        ticketHash: sha256(ticket),
        purpose: 'download',
        audience: 'gateway',
        resource: 'export-1',
      });
      expect(issued.outcome).toBe('issued');
      return ticket;
    };
    const expired = await mint();
    await owner.query(
      `UPDATE uts.tickets SET created_at = now() - interval '2 minutes',
              expires_at = now() - interval '1 minute' WHERE ticket_hash = $1`,
      [sha256(expired)]
    );
    expect(
      (await tickets.redeem(environment, sha256(expired), 'gateway', 'download', 'export-1'))
        .outcome
    ).toBe('unknown');

    const live = await mint();
    await owner.query(
      `UPDATE uts.refresh_grants SET status = 'revoked', revoked_at = now(), revoke_reason = 'sign_out'
       WHERE id = $1`,
      [grant.grantId]
    );
    expect(
      (await tickets.redeem(environment, sha256(live), 'gateway', 'download', 'export-1')).outcome
    ).toBe('unknown');
  });

  it('redeem an organization ticket only while the membership and SSO requirement still hold', async () => {
    const mint = async (grant: { refreshToken: string; grantId: string; jkt: Buffer }) => {
      const ticket = token();
      const issued = await tickets.issue({
        environment,
        tokenHash: sha256(grant.refreshToken),
        grantId: grant.grantId,
        clientId: 'kilo-cli',
        proof: { jkt: grant.jkt, jti: randomUUID() },
        ticketHash: sha256(ticket),
        purpose: 'stream',
        audience: 'gateway',
        resource: null,
      });
      expect(issued.outcome).toBe('issued');
      return ticket;
    };
    const memberGrant = async () => {
      const accountId = await insertAccount(owner);
      const orgId = randomUUID();
      await owner.query(
        `INSERT INTO uts.org_memberships (org_id, account_id, role, event_version) VALUES ($1, $2, 'member', 1)`,
        [orgId, accountId]
      );
      return { orgId, grant: await firstPartyGrant(accountId, ['gateway:models.read'], orgId) };
    };

    const removed = await memberGrant();
    const before = await mint(removed.grant);
    expect(
      await tickets.redeem(environment, sha256(before), 'gateway', 'stream', null)
    ).toMatchObject({
      outcome: 'redeemed',
      orgId: removed.orgId,
    });
    const afterRemoval = await mint(removed.grant);
    await owner.query(
      `UPDATE uts.org_memberships SET status = 'removed', removed_at = now() WHERE org_id = $1`,
      [removed.orgId]
    );
    expect(
      await tickets.redeem(environment, sha256(afterRemoval), 'gateway', 'stream', null)
    ).toEqual({
      outcome: 'unknown',
    });

    // The grant signed in with a passkey; an SSO requirement set after the mint refuses it.
    const ssoRequired = await memberGrant();
    const afterPolicy = await mint(ssoRequired.grant);
    await owner.query(
      `INSERT INTO uts.org_sso_policies (org_id, enforcement, event_version) VALUES ($1, 'required', 1)`,
      [ssoRequired.orgId]
    );
    expect(
      await tickets.redeem(environment, sha256(afterPolicy), 'gateway', 'stream', null)
    ).toEqual({
      outcome: 'unknown',
    });
  });
});

describe('sign-in row maintenance', () => {
  it('deletes challenges, device codes, tickets and step-ups an hour past their lifetime', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const old = await challenge('sign_in');
    const kept = await challenge('sign_in');
    await owner.query(
      `UPDATE uts.webauthn_challenges SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '2 hours' + interval '5 minutes' WHERE challenge_hash = $1`,
      [old.hash]
    );
    const oldCode = await deviceCode();
    await owner.query(
      `UPDATE uts.device_codes SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '2 hours' + interval '10 minutes' WHERE device_code_hash = $1`,
      [sha256(oldCode.code)]
    );
    const passkey = await storedPasskey(accountId);
    await owner.query(
      `INSERT INTO uts.step_ups (account_id, browser_session_id, purpose, passkey_credential_id, completed_at, expires_at)
       VALUES ($1, $2, 'gate', $3, now() - interval '2 hours', now() - interval '2 hours' + interval '10 minutes')`,
      [accountId, session.id, passkey.id]
    );
    const app = await db.connect('uts_app_b');
    const result = await app.query<{ kind: string; deleted: number }>(
      'SELECT kind, deleted FROM uts.maintain_sign_in_rows()'
    );
    expect(Object.fromEntries(result.rows.map(row => [row.kind, row.deleted]))).toMatchObject({
      webauthn_challenges: 1,
      device_codes: 1,
      step_ups: 1,
    });
    const left = await owner.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM uts.webauthn_challenges WHERE challenge_hash = ANY ($1)',
      [[old.hash, kept.hash]]
    );
    expect(left.rows[0].count).toBe(1);
  });

  it('deletes a browser session a day after it ended unless a credential still refers to one of its passes', async () => {
    const accountId = await insertAccount(owner);
    const live = await browserSession(accountId);
    const ended = await browserSession(accountId);
    const endedWithPasskey = await browserSession(accountId);
    const endedDeviceApproval = await browserSession(accountId);
    const revoked = await browserSession(accountId);
    // An idle end two days ago; the CHECK needs the idle end within 14 days of the last sight.
    for (const session of [ended, endedWithPasskey, endedDeviceApproval]) {
      await owner.query(
        `UPDATE uts.browser_sessions SET created_at = now() - interval '20 days',
                last_seen_at = now() - interval '16 days', idle_expires_at = now() - interval '2 days',
                expires_at = now() + interval '10 days' WHERE id = $1`,
        [session.id]
      );
    }
    const passkey = await storedPasskey(accountId, 0, endedWithPasskey.id);
    // A device approval's pass, whose device code maintenance already deleted.
    const approvalPass = await insertGatePass(
      owner,
      accountId,
      'device_approve',
      endedDeviceApproval.id
    );
    await owner.query(
      `UPDATE uts.browser_sessions SET status = 'revoked', revoked_at = now() - interval '25 hours',
              revoke_reason = 'sign_out' WHERE id = $1`,
      [revoked.id]
    );
    const app = await db.connect('uts_app_a');
    await app.query('SELECT * FROM uts.maintain_sign_in_rows()');
    const left = await owner.query<{ id: string }>(
      'SELECT id FROM uts.browser_sessions WHERE account_id = $1',
      [accountId]
    );
    expect(left.rows.map(row => row.id).sort()).toEqual([live.id, endedWithPasskey.id].sort());
    const passes = await owner.query('SELECT 1 FROM uts.gate_passes WHERE id = $1', [approvalPass]);
    expect(passes.rows).toEqual([]);

    // The kept session is stamped and left alone for a day; once its passkey is gone, the next
    // look after that day deletes it.
    const stamp = async () =>
      (
        await owner.query<{ kept: Date | null }>(
          'SELECT cleanup_kept_at AS kept FROM uts.browser_sessions WHERE id = $1',
          [endedWithPasskey.id]
        )
      ).rows[0]?.kept;
    const first = await stamp();
    expect(first).toBeInstanceOf(Date);
    await owner.query('DELETE FROM uts.passkey_credentials WHERE id = $1', [passkey.id]);
    await app.query('SELECT * FROM uts.maintain_sign_in_rows()');
    expect(await stamp()).toEqual(first);
    await owner.query(
      `UPDATE uts.browser_sessions SET cleanup_kept_at = now() - interval '25 hours' WHERE id = $1`,
      [endedWithPasskey.id]
    );
    await app.query('SELECT * FROM uts.maintain_sign_in_rows()');
    expect(await stamp()).toBeUndefined();
  });

  it('probes every table whose foreign key refers to a gate pass', async () => {
    // The session cleanup skips a session only for these; a new referring table must join them.
    const referring = await owner.query<{ table: string }>(
      `SELECT conrelid::regclass::text AS table FROM pg_constraint
       WHERE contype = 'f' AND confrelid = 'uts.gate_passes'::regclass ORDER BY 1`
    );
    expect(referring.rows.map(row => row.table)).toEqual([
      'uts.ci_trust_policies',
      'uts.device_codes',
      'uts.org_bot_keys',
      'uts.passkey_credentials',
      'uts.personal_access_tokens',
      'uts.sign_in_flows',
      'uts.sign_in_methods',
      'uts.third_party_consents',
    ]);
  });

  it('deletes wrong user-code counts whose hour has passed, and keeps a running one', async () => {
    const running = await insertAccount(owner);
    const passed = await insertAccount(owner);
    const host = ownNetwork();
    for (const accountId of [running, passed]) {
      await enterWrongCodes((await browserSession(accountId)).hash, host(1), 1);
    }
    await owner.query(
      `UPDATE uts.account_user_code_failures SET window_started_at = now() - interval '61 minutes'
       WHERE account_id = $1`,
      [passed]
    );
    await owner.query(
      `UPDATE uts.network_user_code_failures SET window_started_at = now() - interval '61 minutes'
       WHERE client_network = $1::inet`,
      [`${host(0)}/24`]
    );
    const app = await db.connect('uts_app_a');
    await app.query('SELECT * FROM uts.maintain_sign_in_rows()');
    const accounts = await owner.query<{ account_id: string }>(
      'SELECT account_id FROM uts.account_user_code_failures WHERE account_id = ANY($1)',
      [[running, passed]]
    );
    expect(accounts.rows).toEqual([{ account_id: running }]);
    const networks = await owner.query(
      'SELECT 1 FROM uts.network_user_code_failures WHERE client_network = $1::inet',
      [`${host(0)}/24`]
    );
    expect(networks.rows).toEqual([]);
  });
});

describe('anonymous write limits', () => {
  const create = (clientIp: string) =>
    signIn.createDeviceCode({
      deviceCodeHash: sha256(token()),
      userCodeHash: randomBytes(32),
      clientId: 'kilo-cli',
      scopes: ['gateway:models.read'],
      network: { ...network, clientIp },
    });

  it('holds at most 5 pending device codes per IPv4 address, so one host cannot block its /24', async () => {
    const [first, second] = randomBytes(2);
    const host = `172.${16 + (first % 16)}.${second}`;
    for (let code = 0; code < 5; code++) {
      expect((await create(`${host}.1`)).outcome).toBe('created');
    }
    expect(await create(`${host}.1`)).toEqual({ outcome: 'too_many_pending' });
    expect((await create(`${host}.2`)).outcome).toBe('created');
    const writers = await owner.query<{ v4: string; v6: string; none: string | null }>(
      `SELECT uts.anonymous_writer('192.0.2.77')::text AS v4,
              uts.anonymous_writer('2001:db8:1:2::5')::text AS v6,
              uts.anonymous_writer(NULL)::text AS none`
    );
    expect(writers.rows).toEqual([{ v4: '192.0.2.77/32', v6: '2001:db8:1::/48', none: null }]);
  });

  it('holds at most 5 pending device codes per IPv6 /48, whatever /64 each came from', async () => {
    const site = `2001:db8:${randomBytes(2).toString('hex')}`;
    for (let subnet = 0; subnet < 5; subnet++) {
      expect((await create(`${site}:${subnet}::1`)).outcome).toBe('created');
    }
    expect(await create(`${site}:ffff:1:2:3:4`)).toEqual({ outcome: 'too_many_pending' });
    const stored = await owner.query<{ network: string }>(
      `SELECT DISTINCT anonymous_writer::text AS network FROM uts.device_codes
       WHERE anonymous_writer = uts.anonymous_writer($1::inet)`,
      [`${site}::1`]
    );
    expect(stored.rows).toHaveLength(1);
  });
});

describe('required inputs (migration 0020)', () => {
  const NULL_VALUE_NOT_ALLOWED = '22004';

  it('refuse a device decision whose approval is NULL instead of approving it', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const { userCodeHash } = await deviceCode();
    expect(
      await sqlStateOf(() =>
        app.query('SELECT * FROM uts.decide_device_code($1, $2, $3, $4, $5, $6)', [
          environment,
          userCodeHash,
          session.hash,
          network.clientIp,
          true,
          null,
        ])
      )
    ).toBe(NULL_VALUE_NOT_ALLOWED);
    const code = await owner.query(
      'SELECT status FROM uts.device_codes WHERE user_code_hash = $1',
      [userCodeHash]
    );
    expect(code.rows).toEqual([{ status: 'pending' }]);
  });

  it('refuse a device exchange without a client id instead of skipping the client check', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const { code, userCodeHash } = await deviceCode();
    expect(
      await signIn.decideDeviceCode({
        environment,
        userCodeHash,
        sessionTokenHash: session.hash,
        clientIp: network.clientIp,
        source: 'typed',
        approve: true,
      })
    ).toBe('approved');
    const input = exchangeInput(code);
    expect(
      await sqlStateOf(() =>
        app.query(
          `SELECT * FROM uts.exchange_device_code($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14, $15, $16)`,
          [
            environment,
            input.deviceCodeHash,
            null,
            input.clientClass,
            input.proof.jkt,
            input.proof.jti,
            input.grantId,
            input.refreshTokenHash,
            device.label,
            device.platform,
            device.clientIp,
            device.asn,
            device.country,
            device.city,
            null,
            null,
          ]
        )
      )
    ).toBe(NULL_VALUE_NOT_ALLOWED);
    expect((await signIn.exchangeDeviceCode(input)).outcome).toBe('issued');
  });

  it('refuse a ticket mint without the grant id, client id or DPoP key instead of skipping their checks', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const mint = (grantId: string | null, clientId: string | null, jkt: Buffer | null) =>
      app.query('SELECT * FROM uts.issue_ticket($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [
        environment,
        sha256(grant.refreshToken),
        grantId,
        clientId,
        jkt,
        randomUUID(),
        sha256(token()),
        'stream',
        'gateway',
        null,
      ]);
    for (const [grantId, clientId, jkt] of [
      [null, 'kilo-cli', grant.jkt],
      [grant.grantId, null, grant.jkt],
      [grant.grantId, 'kilo-cli', null],
    ] as const) {
      expect(await sqlStateOf(() => mint(grantId, clientId, jkt))).toBe(NULL_VALUE_NOT_ALLOWED);
    }
    expect(
      (await auditTypes(accountId)).filter(type => type === 'ai.kilo.uts.ticket.issued')
    ).toEqual([]);
  });

  it('refuse a redemption without an audience instead of skipping the audience check', async () => {
    const accountId = await insertAccount(owner);
    const grant = await firstPartyGrant(accountId);
    const ticket = token();
    const issued = await tickets.issue({
      environment,
      tokenHash: sha256(grant.refreshToken),
      grantId: grant.grantId,
      clientId: 'kilo-cli',
      proof: { jkt: grant.jkt, jti: randomUUID() },
      ticketHash: sha256(ticket),
      purpose: 'stream',
      audience: 'kilo-chat',
      resource: null,
    });
    expect(issued.outcome).toBe('issued');
    expect(
      await sqlStateOf(() =>
        app.query('SELECT * FROM uts.redeem_ticket($1, $2, $3, $4, $5)', [
          environment,
          sha256(ticket),
          null,
          'stream',
          null,
        ])
      )
    ).toBe(NULL_VALUE_NOT_ALLOWED);
    const stored = await owner.query('SELECT status FROM uts.tickets WHERE ticket_hash = $1', [
      sha256(ticket),
    ]);
    expect(stored.rows).toEqual([{ status: 'issued' }]);
  });
});

describe('tier A passes of a browser session (migration 0020)', () => {
  /** A pending tier A code to the account's primary address, as the gate's mail would store it. */
  async function tierACode(accountId: string, address: 'current' | 'new' = 'current') {
    const [email, code] = [randomBytes(32), randomBytes(32)];
    await owner.query(
      `INSERT INTO uts.email_codes (purpose, email_hash, account_id, code_hash, expires_at, address)
       VALUES ('tier_a', $1, $2, $3, now() + interval '10 minutes', $4)`,
      [email, accountId, code, address]
    );
    return { email, code };
  }

  async function open(
    sessionHash: Buffer,
    action: string,
    codes: { email: Buffer; code: Buffer | null; newEmail?: Buffer; newCode?: Buffer }
  ) {
    const result = await app.query<{ outcome: string; gate_pass_id: string | null }>(
      'SELECT outcome, gate_pass_id FROM uts.open_browser_tier_a_gate_pass($1, $2, $3, $4, $5, $6, $7)',
      [
        environment,
        sessionHash,
        action,
        codes.email,
        codes.code,
        codes.newEmail ?? null,
        codes.newCode ?? null,
      ]
    );
    return result.rows[0];
  }

  async function codeState(email: Buffer) {
    const result = await owner.query(
      'SELECT status, attempts FROM uts.email_codes WHERE email_hash = $1',
      [email]
    );
    return result.rows;
  }

  it('open for the session after a recent sign-in and the emailed code, and passkey registration consumes the pass', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const codes = await tierACode(accountId);
    const opened = await open(session.hash, 'passkey_add', codes);
    expect(opened.outcome).toBe('opened');
    const pass = await owner.query(
      `SELECT browser_session_id, device_session_id, tier, action, status,
              satisfied_by::text[] AS satisfied_by
       FROM uts.gate_passes WHERE id = $1`,
      [opened.gate_pass_id]
    );
    expect(pass.rows).toEqual([
      {
        browser_session_id: session.id,
        device_session_id: null,
        tier: 'a',
        action: 'passkey_add',
        status: 'open',
        satisfied_by: ['recent_sign_in', 'email_code'],
      },
    ]);
    expect(await codeState(codes.email)).toEqual([{ status: 'consumed', attempts: 0 }]);

    const { hash, result } = await challenge('registration', session.hash);
    expect(result.outcome).toBe('created');
    const registered = await signIn.registerPasskey({
      environment,
      challengeHash: hash,
      sessionTokenHash: session.hash,
      credentialId: randomBytes(32),
      publicKey: randomBytes(77),
      signCount: 0n,
      aaguid: randomUUID(),
      transports: ['internal'],
      backupEligible: true,
      backedUp: true,
      name: 'Work laptop',
    });
    expect(registered.outcome).toBe('registered');
    const stored = await owner.query(
      `SELECT passkey.gate_pass_id, pass.status FROM uts.passkey_credentials AS passkey
       JOIN uts.gate_passes AS pass ON pass.id = passkey.gate_pass_id
       WHERE passkey.account_id = $1`,
      [accountId]
    );
    expect(stored.rows).toEqual([{ gate_pass_id: opened.gate_pass_id, status: 'consumed' }]);
    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).toEqual([
      'ai.kilo.uts.gate.passed',
      'ai.kilo.uts.passkey.registered',
    ]);
    expect(rows[0].event.data.attributes).toMatchObject({
      action: 'passkey_add',
      tier: 'a',
      gatePassId: opened.gate_pass_id,
      sessionId: session.id,
    });
  });

  it('need a sign-in with the strongest method of the account within 10 minutes', async () => {
    const accountId = await insertAccount(owner);
    const stale = await browserSession(accountId, 11);
    const codes = await tierACode(accountId);
    expect((await open(stale.hash, 'method_add', codes)).outcome).toBe('gate_required');
    await storedPasskey(accountId);
    // The account holds a passkey now: a fresh sign-in by another method does not do.
    const fresh = await browserSession(accountId);
    expect((await open(fresh.hash, 'method_add', codes)).outcome).toBe('gate_required');
    expect(await codeState(codes.email)).toEqual([{ status: 'pending', attempts: 0 }]);
    const passkeyToken = token();
    await owner.query(
      `INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
       VALUES ($1, $2, now(), '{passkey}', now() + interval '14 days', now() + interval '29 days')`,
      [accountId, sha256(passkeyToken)]
    );
    expect((await open(sha256(passkeyToken), 'method_add', codes)).outcome).toBe('opened');
    expect(await auditTypes(accountId)).toEqual([
      'ai.kilo.uts.gate.refused',
      'ai.kilo.uts.gate.refused',
      'ai.kilo.uts.gate.passed',
    ]);
  });

  it('refuse an unknown session, a wrong code, a removal in the cooling-off day and a missing code', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const codes = await tierACode(accountId);
    expect((await open(randomBytes(32), 'method_add', codes)).outcome).toBe('no_session');
    expect(
      (await open(session.hash, 'method_add', { ...codes, code: randomBytes(32) })).outcome
    ).toBe('code_invalid');
    expect(await codeState(codes.email)).toEqual([{ status: 'pending', attempts: 1 }]);
    expect(await sqlStateOf(() => open(session.hash, 'method_add', { ...codes, code: null }))).toBe(
      '22004'
    );
    expect(await sqlStateOf(() => open(session.hash, 'pat_create', codes))).toBe('22023');
    await owner.query(
      `INSERT INTO uts.sign_in_methods (account_id, provider, provider_subject, added_at)
       VALUES ($1, 'github', $2, now() - interval '1 hour')`,
      [accountId, randomUUID()]
    );
    expect((await open(session.hash, 'method_remove', codes)).outcome).toBe('cooling_off');
    expect(await codeState(codes.email)).toEqual([{ status: 'pending', attempts: 1 }]);
  });

  it('need both codes for an email change, each in its own role', async () => {
    const accountId = await insertAccount(owner);
    const session = await browserSession(accountId);
    const current = await tierACode(accountId);
    const next = await tierACode(accountId, 'new');
    expect(await sqlStateOf(() => open(session.hash, 'email_change', current))).toBe('22023');
    // Each code counts only in its own role: swapped, neither matches.
    expect(
      (
        await open(session.hash, 'email_change', {
          email: next.email,
          code: next.code,
          newEmail: current.email,
          newCode: current.code,
        })
      ).outcome
    ).toBe('code_invalid');
    const opened = await open(session.hash, 'email_change', {
      ...current,
      newEmail: next.email,
      newCode: next.code,
    });
    expect(opened.outcome).toBe('opened');
    const pass = await owner.query(
      'SELECT satisfied_by::text[] AS satisfied_by FROM uts.gate_passes WHERE id = $1',
      [opened.gate_pass_id]
    );
    expect(pass.rows).toEqual([
      { satisfied_by: ['recent_sign_in', 'email_code', 'email_code_new'] },
    ]);
  });
});
