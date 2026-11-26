import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, loadMigrations } from '../../scripts/migrator';
import { IdentityStore } from '../../src/db/client';
import { NoticeAttemptRowSchema, SignInRowSchema } from '../../src/db/rows';
import { credentialNotices } from '../../src/notices/credential';
import { type NoticeDeps, dispatchNotice, sweepNotices } from '../../src/notices/dispatch';
import {
  type FakeAnswers,
  type RecordedMessage,
  ALWAYS_SENT,
  fakeTransports,
} from '../../src/notices/fake-transports';
import type { NoticeKind } from '../../src/notices/kinds';
import { type NoticeStore, identityStoreNotices } from '../../src/notices/store';
import { readSecurityView } from '../../src/notices/security-view';
import { TestDatabase, insertAccount, insertGatePass, randomHash, sqlStateOf } from './harness';

/**
 * Migration 0010 through the Worker's own statements (`src/notices/*`): sign-in recording and
 * new-device-and-network detection by the session triggers, the notice claim and finish, the
 * credential notice port, the background pass, and the security view on the reader login.
 * Sessions and grants are inserted as the owner, as the sign-in and grant functions do.
 */

let db: TestDatabase;
let owner: pg.Client;
let app: pg.Client;
let reader: pg.Client;
let notices: NoticeStore;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  app = await db.connect('uts_app_a');
  reader = await db.connect('uts_reader_a');
  notices = identityStoreNotices(new IdentityStore(app));
});
afterAll(() => db.drop());

type Network = { ip: string | null; asn: number | null; country?: string; city?: string };
const BERLIN: Network = { ip: '198.51.100.7', asn: 3320, country: 'DE', city: 'Berlin' };
const PARIS: Network = { ip: '203.0.113.9', asn: 3215, country: 'FR', city: 'Paris' };
const BERLIN_OTHER_ADDRESS: Network = { ...BERLIN, ip: '198.51.100.200' };

/** A device sign-in as the code exchange writes it: a device session, then its refresh grant. */
async function deviceSignIn(
  client: pg.Client,
  accountId: string,
  deviceKey: Buffer,
  network: Network
): Promise<{ sessionId: string; grantId: string }> {
  const session = await client.query<{ id: string }>(
    `INSERT INTO uts.device_sessions
       (account_id, client_class, device_label, platform, auth_time, amr, client_ip, asn, country, city)
     VALUES ($1, 'desktop', 'Kilo CLI 1.2.3', 'linux', now(), '{passkey}', $2, $3, $4, $5)
     RETURNING id`,
    [accountId, network.ip, network.asn, network.country ?? null, network.city ?? null]
  );
  const grant = await client.query<{ id: string }>(
    `INSERT INTO uts.refresh_grants
       (account_id, device_session_id, client_id, client_class, token_hash, dpop_jkt, allowed_scopes,
        idle_expires_at, expires_at)
     VALUES ($1, $2, 'kilo-cli', 'desktop', $3, $4, '{gateway:models.read}',
             now() + interval '30 days', now() + interval '180 days')
     RETURNING id`,
    [accountId, session.rows[0].id, randomHash(), deviceKey]
  );
  return { sessionId: session.rows[0].id, grantId: grant.rows[0].id };
}

async function browserSignIn(
  accountId: string,
  deviceKey: Buffer | null,
  network: Network
): Promise<string> {
  const session = await owner.query<{ id: string }>(
    `INSERT INTO uts.browser_sessions
       (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at, user_agent, client_ip,
        asn, country, city, device_key_hash)
     VALUES ($1, $2, now(), '{oauth}', now() + interval '14 days', now() + interval '30 days',
             'Mozilla/5.0 (Macintosh) Firefox/140.0', $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      accountId,
      randomHash(),
      network.ip,
      network.asn,
      network.country ?? null,
      network.city ?? null,
      deviceKey,
    ]
  );
  return session.rows[0].id;
}

async function signIns(accountId: string) {
  const result = await owner.query(
    'SELECT * FROM uts.sign_ins WHERE account_id = $1 ORDER BY signed_in_at, id',
    [accountId]
  );
  return result.rows.map(row => SignInRowSchema.parse(row));
}

async function noticeRows(accountId: string) {
  const result = await owner.query<{
    id: string;
    kind: string;
    details: Record<string, unknown>;
    delivery: string;
  }>(
    'SELECT id, kind, details, delivery FROM uts.notices WHERE account_id = $1 ORDER BY created_at',
    [accountId]
  );
  return result.rows;
}

async function attempts(noticeId: string) {
  const result = await owner.query(
    'SELECT * FROM uts.notice_attempts WHERE notice_id = $1 ORDER BY round, position',
    [noticeId]
  );
  return result.rows.map(row => {
    const attempt = NoticeAttemptRowSchema.parse(row);
    return { round: attempt.round, channel: attempt.channel, outcome: attempt.outcome };
  });
}

async function insertNotice(
  accountId: string,
  kind: NoticeKind,
  details: object = {}
): Promise<string> {
  const result = await app.query<{ id: string }>(
    'INSERT INTO uts.notices (account_id, kind, details) VALUES ($1, $2, $3) RETURNING id',
    [accountId, kind, details]
  );
  return result.rows[0].id;
}

function noticeDeps(answers: FakeAnswers, outbox: RecordedMessage[]): NoticeDeps {
  return {
    notices: work => work(notices),
    transports: fakeTransports(answers, outbox),
    now: () => new Date(),
  };
}

/** An account that already signed in once, from `BERLIN` on device `home`. */
async function accountWithBaseline() {
  const accountId = await insertAccount(owner);
  const home = randomBytes(32);
  await deviceSignIn(owner, accountId, home, BERLIN);
  return { accountId, home };
}

describe('sign-in recording and new-device-and-network detection', () => {
  it('records the first sign-in of an account as its baseline, without a notice', async () => {
    const { accountId } = await accountWithBaseline();
    const rows = await signIns(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_kind: 'device',
      amr: ['passkey'],
      device_label: 'Kilo CLI 1.2.3',
      asn: 3320,
      country: 'DE',
      new_device: true,
      new_network: true,
      notice_id: null,
    });
    expect(await noticeRows(accountId)).toEqual([]);
  });

  it('fires one notice for a new device on a new network, with the kind of device and the region', async () => {
    const { accountId } = await accountWithBaseline();
    await deviceSignIn(owner, accountId, randomBytes(32), PARIS);
    const [notice] = await noticeRows(accountId);
    expect(notice).toMatchObject({ kind: 'new_device_network', delivery: 'pending' });
    // The client's own label and platform stay in the sign-in row, never in the notice.
    expect(notice.details).toEqual({
      sessionKind: 'device',
      deviceKind: 'desktop',
      country: 'FR',
      city: 'Paris',
      methods: ['passkey'],
    });
    const rows = await signIns(accountId);
    expect(rows.at(-1)).toMatchObject({
      new_device: true,
      new_network: true,
      notice_id: notice.id,
    });
  });

  it('fires nothing for a known device on a new network or a new device on a known network', async () => {
    const { accountId, home } = await accountWithBaseline();
    await deviceSignIn(owner, accountId, home, PARIS);
    await deviceSignIn(owner, accountId, randomBytes(32), BERLIN_OTHER_ADDRESS);
    expect(await noticeRows(accountId)).toEqual([]);
    expect((await signIns(accountId)).map(row => [row.new_device, row.new_network])).toEqual([
      [true, true],
      [false, true],
      [true, false],
    ]);
  });

  it('treats a new address in a known autonomous system as a known network', async () => {
    const { accountId } = await accountWithBaseline();
    await deviceSignIn(owner, accountId, randomBytes(32), { ...BERLIN, ip: '192.0.2.44' });
    expect(await noticeRows(accountId)).toEqual([]);
  });

  it('keys a network by its /24 prefix when the autonomous system is unknown', async () => {
    const accountId = await insertAccount(owner);
    await deviceSignIn(owner, accountId, randomBytes(32), { ip: '192.0.2.10', asn: null });
    await deviceSignIn(owner, accountId, randomBytes(32), { ip: '192.0.2.99', asn: null });
    await deviceSignIn(owner, accountId, randomBytes(32), { ip: '192.0.3.1', asn: null });
    const keys = await owner.query<{ network_key: string }>(
      'SELECT network_key FROM uts.known_networks WHERE account_id = $1 ORDER BY network_key',
      [accountId]
    );
    expect(keys.rows.map(row => row.network_key)).toEqual(['net:192.0.2.0/24', 'net:192.0.3.0/24']);
    expect((await noticeRows(accountId)).map(row => row.kind)).toEqual(['new_device_network']);
  });

  it('fires once when the same new device and network sign in twice', async () => {
    const { accountId } = await accountWithBaseline();
    const laptop = randomBytes(32);
    await deviceSignIn(owner, accountId, laptop, PARIS);
    await deviceSignIn(owner, accountId, laptop, PARIS);
    expect(await noticeRows(accountId)).toHaveLength(1);
  });

  it('fires once when two sign-ins from one new device and network run at the same time', async () => {
    const { accountId } = await accountWithBaseline();
    const laptop = randomBytes(32);
    const first = await db.connectAsOwner();
    const second = await db.connectAsOwner();
    await first.query('BEGIN');
    await second.query('BEGIN');
    await deviceSignIn(first, accountId, laptop, PARIS);
    // The second statement waits on the first one's new key until the first commits.
    const waiting = deviceSignIn(second, accountId, laptop, PARIS);
    await first.query('COMMIT');
    await waiting;
    await second.query('COMMIT');
    expect(await noticeRows(accountId)).toHaveLength(1);
    expect((await signIns(accountId)).map(row => [row.new_device, row.new_network])).toEqual([
      [true, true],
      [true, true],
      [false, false],
    ]);
  });

  it('counts a device and a network unseen for 90 days as new again', async () => {
    const { accountId, home } = await accountWithBaseline();
    await owner.query(
      `UPDATE uts.known_devices SET first_seen_at = now() - interval '200 days',
         last_seen_at = now() - interval '91 days' WHERE account_id = $1`,
      [accountId]
    );
    await owner.query(
      `UPDATE uts.known_networks SET first_seen_at = now() - interval '200 days',
         last_seen_at = now() - interval '91 days' WHERE account_id = $1`,
      [accountId]
    );
    await deviceSignIn(owner, accountId, home, BERLIN);
    expect((await noticeRows(accountId)).map(row => row.kind)).toEqual(['new_device_network']);
  });

  it('counts a browser without a device key as a new device every time', async () => {
    const { accountId } = await accountWithBaseline();
    await browserSignIn(accountId, null, BERLIN);
    expect(await noticeRows(accountId)).toEqual([]);
    await browserSignIn(accountId, null, PARIS);
    await browserSignIn(accountId, null, PARIS);
    const rows = await signIns(accountId);
    expect(rows.slice(1).map(row => [row.session_kind, row.new_device, row.new_network])).toEqual([
      ['browser', true, false],
      ['browser', true, true],
      ['browser', true, false],
    ]);
    const [notice] = await noticeRows(accountId);
    expect(notice.details).toMatchObject({ sessionKind: 'browser', deviceKind: 'browser' });
    expect(JSON.stringify(notice.details)).not.toContain('Mozilla');
  });

  it('records a browser with an empty user agent, without a label', async () => {
    const { accountId } = await accountWithBaseline();
    await owner.query(
      `INSERT INTO uts.browser_sessions
         (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at, user_agent)
       VALUES ($1, $2, now(), '{oauth}', now() + interval '14 days', now() + interval '30 days', '')`,
      [accountId, randomHash()]
    );
    expect((await signIns(accountId)).at(-1)).toMatchObject({
      session_kind: 'browser',
      device_label: null,
    });
  });

  it('counts an older live session as the baseline, even one without network data', async () => {
    const accountId = await insertAccount(owner);
    await owner.query(
      `INSERT INTO uts.device_sessions (account_id, client_class, device_label, platform, auth_time, amr)
       VALUES ($1, 'mobile', 'old phone', 'ios', now(), '{passkey}')`,
      [accountId]
    );
    await deviceSignIn(owner, accountId, randomBytes(32), PARIS);
    expect((await noticeRows(accountId)).map(row => row.kind)).toEqual(['new_device_network']);
  });

  it('counts an earlier sign-in without network data as the baseline', async () => {
    const accountId = await insertAccount(owner);
    await deviceSignIn(owner, accountId, randomBytes(32), { ip: null, asn: null });
    await owner.query(
      `UPDATE uts.device_sessions SET status = 'revoked', revoked_at = now(), revoke_reason = 'sign_out'
       WHERE account_id = $1`,
      [accountId]
    );
    await deviceSignIn(owner, accountId, randomBytes(32), PARIS);
    expect((await noticeRows(accountId)).map(row => row.kind)).toEqual(['new_device_network']);
  });

  it('recognises a browser by its device key', async () => {
    const { accountId } = await accountWithBaseline();
    const browser = randomBytes(32);
    await browserSignIn(accountId, browser, BERLIN);
    await browserSignIn(accountId, browser, PARIS);
    expect(await noticeRows(accountId)).toEqual([]);
  });

  it('fires nothing when the sign-in carries no network', async () => {
    const { accountId } = await accountWithBaseline();
    await deviceSignIn(owner, accountId, randomBytes(32), { ip: null, asn: null });
    expect(await noticeRows(accountId)).toEqual([]);
  });

  it('keeps the newest 50 sign-ins of an account', async () => {
    const { accountId, home } = await accountWithBaseline();
    for (let index = 0; index < 52; index += 1) await deviceSignIn(owner, accountId, home, BERLIN);
    expect(await signIns(accountId)).toHaveLength(50);
  });

  it('lets only the session triggers write sign-in rows, not the app login', async () => {
    const accountId = await insertAccount(owner);
    expect(
      await sqlStateOf(() =>
        app.query(
          `INSERT INTO uts.sign_ins (account_id, session_kind, amr, new_device, new_network)
           VALUES ($1, 'device', '{passkey}', true, true)`,
          [accountId]
        )
      )
    ).toBe('42501');
  });
});

describe('notice delivery statements', () => {
  it('claims a notice once, finishes it with push then email, and delivers it', async () => {
    const accountId = await insertAccount(owner);
    const noticeId = await insertNotice(accountId, 'sessions_revoked');
    const outbox: RecordedMessage[] = [];
    const result = await dispatchNotice(noticeDeps(ALWAYS_SENT, outbox), noticeId);
    expect(result?.finish).toEqual({ outcome: 'finished', delivery: 'delivered' });
    expect(await attempts(noticeId)).toEqual([
      { round: 1, channel: 'push', outcome: 'sent' },
      { round: 1, channel: 'email', outcome: 'sent' },
    ]);
    expect(await dispatchNotice(noticeDeps(ALWAYS_SENT, outbox), noticeId)).toBeNull();
    expect(outbox).toHaveLength(2);
  });

  it('lets one of two concurrent claims win', async () => {
    const accountId = await insertAccount(owner);
    const noticeId = await insertNotice(accountId, 'suspicious_sign_in');
    const other = identityStoreNotices(new IdentityStore(await db.connect('uts_app_b')));
    const claims = await Promise.all([notices.claimNotice(noticeId), other.claimNotice(noticeId)]);
    expect(claims.filter(claim => claim !== null)).toHaveLength(1);
  });

  it('retries only the channel that failed in a way that can succeed later', async () => {
    const accountId = await insertAccount(owner);
    const noticeId = await insertNotice(accountId, 'third_party_client_approved', {
      clientName: 'Example MCP client',
    });
    const outbox: RecordedMessage[] = [];
    const first = await dispatchNotice(
      noticeDeps({ push: () => 'sent', email: () => 'retryable_failure' }, outbox),
      noticeId
    );
    expect(first?.finish).toEqual({ outcome: 'finished', delivery: 'pending' });
    const pending = await owner.query<{ due_in: number }>(
      `SELECT extract(epoch FROM next_attempt_at - now())::int AS due_in FROM uts.notices WHERE id = $1`,
      [noticeId]
    );
    expect(pending.rows[0].due_in).toBeGreaterThan(50);
    expect(await notices.claimNotice(noticeId)).toBeNull();

    await owner.query('UPDATE uts.notices SET next_attempt_at = now() WHERE id = $1', [noticeId]);
    const second = await dispatchNotice(noticeDeps(ALWAYS_SENT, outbox), noticeId);
    expect(second?.finish).toEqual({ outcome: 'finished', delivery: 'delivered' });
    expect(await attempts(noticeId)).toEqual([
      { round: 1, channel: 'push', outcome: 'sent' },
      { round: 1, channel: 'email', outcome: 'retryable_failure' },
      { round: 2, channel: 'email', outcome: 'sent' },
    ]);
    expect(outbox.map(entry => entry.channel)).toEqual(['push', 'email', 'email']);
  });

  it('fails a notice that no channel could send, and gives up after the third round', async () => {
    const accountId = await insertAccount(owner);
    const refused = await insertNotice(accountId, 'device_sign_in_approved');
    const permanent = await dispatchNotice(
      noticeDeps({ push: () => 'no_target', email: () => 'permanent_failure' }, []),
      refused
    );
    expect(permanent?.finish).toEqual({ outcome: 'finished', delivery: 'failed' });

    const flaky = await insertNotice(accountId, 'device_sign_in_approved');
    const failing = noticeDeps(
      { push: () => 'retryable_failure', email: () => 'retryable_failure' },
      []
    );
    const deliveries = [];
    for (let round = 1; round <= 3; round += 1) {
      await owner.query('UPDATE uts.notices SET next_attempt_at = now() WHERE id = $1', [flaky]);
      deliveries.push((await dispatchNotice(failing, flaky))?.finish);
    }
    expect(deliveries).toEqual([
      { outcome: 'finished', delivery: 'pending' },
      { outcome: 'finished', delivery: 'pending' },
      { outcome: 'finished', delivery: 'failed' },
    ]);
    expect(await attempts(flaky)).toHaveLength(6);
  });

  it('drops a late finish of a claim that another round replaced', async () => {
    const accountId = await insertAccount(owner);
    const noticeId = await insertNotice(accountId, 'sessions_revoked');
    const stale = await notices.claimNotice(noticeId);
    await owner.query(
      `UPDATE uts.notices SET claimed_at = now() - interval '6 minutes' WHERE id = $1`,
      [noticeId]
    );
    const fresh = await notices.claimNotice(noticeId);
    expect(fresh?.round).toBe(2);
    expect(
      await notices.finishNotice({
        noticeId,
        claimId: stale?.claimId ?? '',
        planned: ['push', 'email'],
        attempts: [{ channel: 'push', outcome: 'sent', attemptedAt: new Date() }],
      })
    ).toEqual({ outcome: 'stale_claim' });
    expect(await attempts(noticeId)).toEqual([]);
  });

  it('sends an email change to the previous address too, then forgets both addresses', async () => {
    const accountId = await insertAccount(owner);
    const result = await owner.query<{ id: string }>(
      `INSERT INTO uts.notices (account_id, kind, old_email) VALUES ($1, 'primary_email_changed', 'old@example.com')
       RETURNING id`,
      [accountId]
    );
    const outbox: RecordedMessage[] = [];
    await dispatchNotice(noticeDeps(ALWAYS_SENT, outbox), result.rows[0].id);
    const email = outbox.find(entry => entry.channel === 'email');
    expect(email?.message).toMatchObject({
      to: [expect.stringMatching(/@example\.com$/), 'old@example.com'],
    });
    const row = await owner.query(
      'SELECT recipient_email, old_email FROM uts.notices WHERE id = $1',
      [result.rows[0].id]
    );
    expect(row.rows).toEqual([{ recipient_email: null, old_email: null }]);
    expect(
      await sqlStateOf(() =>
        owner.query(
          `INSERT INTO uts.notices (account_id, kind, old_email) VALUES ($1, 'sessions_revoked', 'x@example.com')`,
          [accountId]
        )
      )
    ).toBe('23514');
  });

  it('emails the address of the event time even after the account changed it', async () => {
    const accountId = await insertAccount(owner);
    const before = await owner.query<{ primary_email: string }>(
      'SELECT primary_email FROM uts.accounts WHERE id = $1',
      [accountId]
    );
    const noticeId = await insertNotice(accountId, 'new_device_network', { deviceKind: 'browser' });
    const stored = await owner.query('SELECT recipient_email FROM uts.notices WHERE id = $1', [
      noticeId,
    ]);
    expect(stored.rows).toEqual([{ recipient_email: before.rows[0].primary_email }]);
    await owner.query(`UPDATE uts.accounts SET primary_email = 'thief@example.com' WHERE id = $1`, [
      accountId,
    ]);
    const outbox: RecordedMessage[] = [];
    await dispatchNotice(noticeDeps(ALWAYS_SENT, outbox), noticeId);
    const email = outbox.find(entry => entry.channel === 'email');
    expect(email?.message).toMatchObject({
      to: [before.rows[0].primary_email, 'thief@example.com'],
    });
  });

  it('claims the credential notice a create statement wrote, by account and credential', async () => {
    const accountId = await insertAccount(owner);
    const patId = randomUUID();
    const noticeId = await insertNotice(accountId, 'credential_created', {
      credential: 'pat',
      patId,
      scope: 'gateway:models.read',
    });
    const outbox: RecordedMessage[] = [];
    const send = credentialNotices(noticeDeps(ALWAYS_SENT, outbox));
    await send({ kind: 'bot_key_created', accountId, credentialId: patId });
    expect(outbox).toEqual([]);
    await send({ kind: 'pat_created', accountId, credentialId: patId });
    await send({ kind: 'pat_created', accountId, credentialId: patId });
    expect(outbox.map(entry => entry.channel)).toEqual(['push', 'email']);
    expect(outbox[0].message).toMatchObject({ title: 'New personal access token' });
    expect(await attempts(noticeId)).toHaveLength(2);
  });

  it('claims no credential notice older than an hour', async () => {
    const accountId = await insertAccount(owner);
    const patId = randomUUID();
    const noticeId = await insertNotice(accountId, 'credential_created', {
      credential: 'pat',
      patId,
    });
    await owner.query(
      `UPDATE uts.notices SET created_at = now() - interval '61 minutes' WHERE id = $1`,
      [noticeId]
    );
    expect(await notices.claimCredentialNotice(accountId, 'pat', patId)).toBeNull();
  });

  it('sweeps due notices, reclaims a stopped claim, and gives up after 24 hours', async () => {
    const accountId = await insertAccount(owner);
    const due = await insertNotice(accountId, 'sign_in_code_stopped');
    const stopped = await insertNotice(accountId, 'suspicious_sign_in');
    await notices.claimNotice(stopped);
    await owner.query(
      `UPDATE uts.notices SET claimed_at = now() - interval '6 minutes' WHERE id = $1`,
      [stopped]
    );
    const old = await insertNotice(accountId, 'sessions_revoked');
    await owner.query(
      `UPDATE uts.notices SET created_at = now() - interval '25 hours' WHERE id = $1`,
      [old]
    );
    // Other test files' notices may be due too; the sweep takes them in the same pass.
    for (let pass = 0; pass < 5; pass += 1) await sweepNotices(noticeDeps(ALWAYS_SENT, []));
    const states = await owner.query<{ id: string; delivery: string }>(
      'SELECT id, delivery FROM uts.notices WHERE id = ANY ($1)',
      [[due, stopped, old]]
    );
    expect(Object.fromEntries(states.rows.map(row => [row.id, row.delivery]))).toEqual({
      [due]: 'delivered',
      [stopped]: 'delivered',
      [old]: 'failed',
    });
    expect(await attempts(due)).toEqual([{ round: 1, channel: 'push', outcome: 'sent' }]);
    expect(await attempts(old)).toEqual([]);
  });

  it('sends a fresh notice while more than 20 stale ones wait, and never sends a stale one', async () => {
    const accountId = await insertAccount(owner);
    const stale: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      stale.push(await insertNotice(accountId, 'sessions_revoked'));
    }
    await owner.query(
      `UPDATE uts.notices SET created_at = now() - interval '30 hours',
         next_attempt_at = now() - interval '30 hours' WHERE id = ANY ($1)`,
      [stale]
    );
    const fresh = await insertNotice(accountId, 'suspicious_sign_in');
    // The direct claim refuses a stale notice; the pass settles stale ones and sends the fresh one.
    expect(await notices.claimNotice(stale[24])).toBeNull();
    const outbox: RecordedMessage[] = [];
    // Notices of the other tests in this file may be due too; the passes take them as well.
    for (let pass = 0; pass < 5; pass += 1) await sweepNotices(noticeDeps(ALWAYS_SENT, outbox));
    expect(await attempts(fresh)).toEqual([
      { round: 1, channel: 'push', outcome: 'sent' },
      { round: 1, channel: 'email', outcome: 'sent' },
    ]);
    const sent = await owner.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM uts.notice_attempts WHERE notice_id = ANY ($1)',
      [stale]
    );
    expect(sent.rows[0].count).toBe(0);
    const states = await owner.query<{ delivery: string; count: number }>(
      `SELECT delivery, count(*)::int AS count FROM uts.notices WHERE id = ANY ($1) GROUP BY 1`,
      [stale]
    );
    expect(states.rows).toEqual([{ delivery: 'failed', count: 25 }]);
  });

  it('clears the sign-ins of a deleted notice through an index probe', async () => {
    // The foreign key's ON DELETE SET NULL runs this update for each deleted notice.
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL enable_seqscan = off');
      const plan = await owner.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN UPDATE uts.sign_ins SET notice_id = NULL WHERE notice_id = $1`,
        [randomUUID()]
      );
      expect(plan.rows.map(row => row['QUERY PLAN']).join('\n')).toContain('sign_ins_notice_idx');
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('deletes devices and networks unseen for 90 days and finished notices after 400 days', async () => {
    const { accountId } = await accountWithBaseline();
    await deviceSignIn(owner, accountId, randomBytes(32), PARIS);
    await owner.query(
      `UPDATE uts.known_devices SET first_seen_at = now() - interval '100 days',
         last_seen_at = now() - interval '91 days' WHERE account_id = $1`,
      [accountId]
    );
    await owner.query(
      `UPDATE uts.known_networks SET first_seen_at = now() - interval '100 days',
         last_seen_at = now() - interval '91 days' WHERE account_id = $1 AND network_key = 'as3215'`,
      [accountId]
    );
    const old = await insertNotice(accountId, 'sessions_revoked');
    await dispatchNotice(noticeDeps(ALWAYS_SENT, []), old);
    const kept = await insertNotice(accountId, 'sessions_revoked');
    await owner.query(
      `UPDATE uts.notices SET created_at = now() - interval '401 days' WHERE id = ANY ($1)`,
      [[old, kept]]
    );
    const steps = await notices.maintainNoticeRows(500);
    expect(steps.map(step => step.kind)).toEqual(['known_devices', 'known_networks', 'notices']);
    const left = await owner.query<{ devices: number; networks: string[]; notices: string[] }>(
      `SELECT
         (SELECT count(*)::int FROM uts.known_devices WHERE account_id = $1) AS devices,
         ARRAY(SELECT network_key FROM uts.known_networks WHERE account_id = $1) AS networks,
         ARRAY(SELECT id::text FROM uts.notices WHERE id = ANY ($2)) AS notices`,
      [accountId, [old, kept]]
    );
    // The pending notice stays (an unfinished notice is never deleted); the delivered one and its
    // attempts go.
    expect(left.rows).toEqual([{ devices: 0, networks: ['as3320'], notices: [kept] }]);
    expect(await attempts(old)).toEqual([]);
    expect(await sqlStateOf(() => app.query('SELECT * FROM uts.maintain_notice_rows(5001)'))).toBe(
      '22023'
    );
  });

  it('refuses a claim of more than 100 notices', async () => {
    expect(await sqlStateOf(() => app.query('SELECT * FROM uts.claim_due_notices(101)'))).toBe(
      '22023'
    );
  });
});

describe('security view', () => {
  it('lists sign-ins, sessions, credentials and notices with their channel attempts', async () => {
    const { accountId } = await accountWithBaseline();
    // The gate pass's own browser session signs in without a network or device key.
    const passId = await insertGatePass(owner, accountId, 'pat_create');
    const { grantId } = await deviceSignIn(owner, accountId, randomBytes(32), PARIS);
    await browserSignIn(accountId, randomBytes(32), BERLIN);
    await owner.query(
      `INSERT INTO uts.personal_access_tokens
         (account_id, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
       VALUES ($1, 'ci', $2, 'abcd', 'gateway', 'gateway:models.read', $3, now() + interval '90 days')`,
      [accountId, randomHash(), passId]
    );
    const [notice] = await noticeRows(accountId);
    await dispatchNotice(
      noticeDeps({ push: () => 'no_target', email: () => 'sent' }, []),
      notice.id
    );

    const result = await readSecurityView(new IdentityStore(reader), { accountId, grantId });
    if (result.outcome !== 'listed') throw new Error('expected the view');
    const { view } = result;
    expect(
      view.sign_ins.map(row => [
        row.session_kind,
        row.network.country,
        row.new_device,
        row.new_network,
      ])
    ).toEqual([
      ['browser', 'DE', true, false],
      ['device', 'FR', true, true],
      ['browser', null, true, false],
      ['device', 'DE', true, true],
    ]);
    expect(view.sessions.map(session => session.kind).sort()).toEqual([
      'browser',
      'browser',
      'device',
      'device',
    ]);
    expect(view.credentials.pats).toMatchObject([
      { name: 'ci', last_four: 'abcd', scope: 'gateway:models.read' },
    ]);
    expect(view.notices).toEqual([
      {
        id: notice.id,
        kind: 'new_device_network',
        created_at: expect.stringMatching(/Z$/),
        title: 'New sign-in from a new device and network',
        text: expect.stringContaining('Approximate location, from the network: Paris, FR'),
        delivery: 'delivered',
        attempts: [
          {
            round: 1,
            channel: 'push',
            outcome: 'no_target',
            attempted_at: expect.stringMatching(/Z$/),
          },
          {
            round: 1,
            channel: 'email',
            outcome: 'sent',
            attempted_at: expect.stringMatching(/Z$/),
          },
        ],
      },
    ]);
    expect(JSON.stringify(view)).not.toMatch(/198\.51\.100|203\.0\.113|@example\.com/);
  });

  it('answers invalid_session for a revoked grant, another account, or an unknown grant', async () => {
    const { accountId } = await accountWithBaseline();
    const { grantId } = await deviceSignIn(owner, accountId, randomBytes(32), PARIS);
    const store = new IdentityStore(reader);
    const other = await insertAccount(owner);
    expect(await readSecurityView(store, { accountId: other, grantId })).toEqual({
      outcome: 'invalid_session',
    });
    expect(await readSecurityView(store, { accountId, grantId: randomUUID() })).toEqual({
      outcome: 'invalid_session',
    });
    await owner.query(
      `UPDATE uts.refresh_grants SET status = 'revoked', revoked_at = now(), revoke_reason = 'sign_out'
       WHERE id = $1`,
      [grantId]
    );
    expect(await readSecurityView(store, { accountId, grantId })).toEqual({
      outcome: 'invalid_session',
    });
  });

  it('runs on the reader login, which reads no sign-in address', async () => {
    expect(await sqlStateOf(() => reader.query('SELECT client_ip FROM uts.sign_ins'))).toBe(
      '42501'
    );
    expect(await sqlStateOf(() => reader.query('SELECT client_ip FROM uts_read.sign_ins'))).toBe(
      '42703'
    );
  });
});

describe('migration 0010 baseline', () => {
  it('records the devices and networks of sessions that predate it', async () => {
    const empty = await TestDatabase.create('empty');
    try {
      const admin = await empty.connect();
      const migrations = await loadMigrations();
      await applyMigrations(
        admin,
        migrations.filter(migration => migration.name !== '0010_notices.sql')
      );
      await admin.query('SET ROLE uts_owner');
      const accountId = await insertAccount(admin);
      const laptop = randomBytes(32);
      await deviceSignIn(admin, accountId, laptop, BERLIN);
      await admin.query(
        `INSERT INTO uts.browser_sessions
           (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at, client_ip)
         VALUES ($1, $2, now(), '{oauth}', now() + interval '14 days', now() + interval '30 days',
                 '192.0.2.77')`,
        [accountId, randomHash()]
      );
      await admin.query('RESET ROLE');
      await applyMigrations(admin, migrations);
      await admin.query('SET ROLE uts_owner');

      const known = await admin.query<{ devices: number; networks: string[] }>(
        `SELECT (SELECT count(*)::int FROM uts.known_devices WHERE account_id = $1 AND device_key = $2)
                  AS devices,
                ARRAY(SELECT network_key FROM uts.known_networks WHERE account_id = $1
                      ORDER BY network_key) AS networks`,
        [accountId, laptop]
      );
      expect(known.rows).toEqual([{ devices: 1, networks: ['as3320', 'net:192.0.2.0/24'] }]);

      // The first sign-in after the migration is compared with that baseline.
      await deviceSignIn(admin, accountId, randomBytes(32), BERLIN);
      await deviceSignIn(admin, accountId, randomBytes(32), PARIS);
      const fired = await admin.query<{ kind: string }>(
        'SELECT kind FROM uts.notices WHERE account_id = $1',
        [accountId]
      );
      expect(fired.rows).toEqual([{ kind: 'new_device_network' }]);
    } finally {
      await empty.drop();
    }
  });
});
