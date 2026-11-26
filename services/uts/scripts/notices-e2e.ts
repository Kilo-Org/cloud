/**
 * Local end-to-end run of the security notices against `wrangler dev -c wrangler.dev.jsonc` and the
 * identity store (README, "Local development"). Synthetic data only; it prints no token, no
 * address and no email address.
 *
 * 1. Real first-party code exchanges through `/authorize` and `/token` sign the development
 *    account in: a baseline device, then a new device on a network the account has not used
 *    (the run renames the account's known network to a documentation ASN to stand for a move),
 *    then a second new device on that now-known network, then the first new device again. Only
 *    the second sign-in may fire `new_device_network`.
 * 2. Every notice kind is delivered through the development routes with fake transports: the
 *    sign-in notice by its id, `credential_created` through the account API's notice port, and
 *    the others as the rows their producers write. Each must try push, then email (push only for
 *    the sign-in code stop), and no message may hold a link.
 * 3. A failed channel: push without a device and email failing retryably leaves the notice
 *    pending; the background pass then retries email only and delivers it.
 * 4. `GET /account/security` lists the sign-ins, sessions, PAT and notices with their attempts,
 *    and refuses the grant once `/revoke` ended it.
 *
 *   UTS_E2E_BASE_URL   the mint Worker, such as http://127.0.0.1:9020/
 *   UTS_E2E_ADMIN_URL  admin login to the identity-store database (loopback only)
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { UTS_ENDPOINTS, UTS_SECURITY_PATH, SecurityViewSchema } from '@kilocode/uts-contracts';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import { z } from 'zod';
import { isLoopbackHost } from './connection';

const base = z.url().parse(process.env.UTS_E2E_BASE_URL);
const adminUrl = z.url().parse(process.env.UTS_E2E_ADMIN_URL);
if (!isLoopbackHost(new URL(adminUrl)))
  throw new Error('the end-to-end run uses a local database only');

const issuer = UTS_ENDPOINTS.development.issuer;
const ACCOUNT = 'dev:uts-local';
const CALLBACK = 'http://127.0.0.1:4100/callback';
const sha256 = (value: string) => createHash('sha256').update(value).digest();
/** Anything a mail client or a phone could open as a link, and any email address. */
const LINK_LIKE = /:\/\/|www\.|[\p{L}\p{N}-]\.\p{L}{2,}|@|https?:/iu;

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = undefined) {
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`
  );
}

async function dpopKey() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    jkt: await calculateJwkThumbprint(jwk, 'sha256'),
    proof: () =>
      new SignJWT({
        jti: randomUUID(),
        htm: 'POST',
        htu: `${issuer}/token`,
        iat: Math.floor(Date.now() / 1000),
      })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk })
        .sign(privateKey),
  };
}
type DeviceKey = Awaited<ReturnType<typeof dpopKey>>;

async function post(
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {}
) {
  const response = await fetch(new URL(path.slice(1), base), {
    method: 'POST',
    body: new URLSearchParams(fields),
    headers,
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

async function devPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(new URL(path.slice(1), base), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

/** One device sign-in: authorize, then exchange the code with the device's DPoP key. */
async function signIn(
  device: DeviceKey,
  label: string
): Promise<{ grantId: string; refreshToken: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL('authorize', base);
  for (const [name, value] of Object.entries({
    response_type: 'code',
    client_id: 'kilo-cli',
    redirect_uri: CALLBACK,
    code_challenge: sha256(verifier).toString('base64url'),
    code_challenge_method: 'S256',
    scope: 'gateway:models.read',
    state: 'notices-e2e',
    dpop_jkt: device.jkt,
  })) {
    url.searchParams.set(name, value);
  }
  const authorized = await fetch(url, { redirect: 'manual' });
  const code = new URL(authorized.headers.get('Location') ?? 'about:blank').searchParams.get(
    'code'
  );
  if (code === null) throw new Error(`authorize answered ${authorized.status}`);
  const exchanged = await post(
    '/token',
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: 'kilo-cli',
      code_verifier: verifier,
      device_label: label,
      device_platform: 'linux',
    },
    { DPoP: await device.proof() }
  );
  const refreshToken = z.object({ refresh_token: z.string() }).parse(exchanged.body).refresh_token;
  const grantId = Buffer.from(refreshToken.slice(8, 30), 'base64url').toString('hex');
  return {
    grantId: `${grantId.slice(0, 8)}-${grantId.slice(8, 12)}-${grantId.slice(12, 16)}-${grantId.slice(16, 20)}-${grantId.slice(20)}`,
    refreshToken,
  };
}

const OutboxSchema = z.object({
  messages: z.array(
    z.discriminatedUnion('channel', [
      z.object({
        channel: z.literal('push'),
        outcome: z.string(),
        message: z.object({
          accountId: z.string(),
          idempotencyKey: z.string(),
          title: z.string(),
          body: z.string(),
        }),
      }),
      z.object({
        channel: z.literal('email'),
        outcome: z.string(),
        message: z.object({ to: z.array(z.string()), subject: z.string(), text: z.string() }),
      }),
    ])
  ),
});

async function outbox() {
  const response = await fetch(new URL('__dev/notices/outbox', base));
  return OutboxSchema.parse(await response.json()).messages;
}

async function main() {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query('SET ROLE uts_owner');
  // A fresh development account, so the run starts at its first sign-in with no older session.
  await admin.query('DELETE FROM uts.accounts WHERE id = $1', [ACCOUNT]);
  await admin.query(`INSERT INTO uts.accounts (id, primary_email) VALUES ($1, 'e2e@example.com')`, [
    ACCOUNT,
  ]);
  const attemptsOf = async (noticeId: string) =>
    (
      await admin.query<{ round: number; channel: string; outcome: string }>(
        'SELECT round, channel, outcome FROM uts.notice_attempts WHERE notice_id = $1 ORDER BY round, position',
        [noticeId]
      )
    ).rows.map(row => `${row.round}:${row.channel}=${row.outcome}`);
  const noticesOf = async (kind: string) =>
    (
      await admin.query<{ id: string; delivery: string }>(
        'SELECT id, delivery FROM uts.notices WHERE account_id = $1 AND kind = $2 ORDER BY created_at',
        [ACCOUNT, kind]
      )
    ).rows;

  // 1. Sign-ins through the real code exchange.
  const home = await dpopKey();
  await signIn(home, 'Baseline laptop');
  check('baseline sign-in fires nothing', (await noticesOf('new_device_network')).length === 0);
  const known = await admin.query<{ network_key: string }>(
    'SELECT network_key FROM uts.known_networks WHERE account_id = $1',
    [ACCOUNT]
  );
  check('the code exchange recorded the network', known.rows.length === 1, {
    networkKind: known.rows[0]?.network_key.startsWith('as') ? 'asn' : 'prefix',
  });
  await admin.query(`UPDATE uts.known_networks SET network_key = 'as64496' WHERE account_id = $1`, [
    ACCOUNT,
  ]);

  const travel = await dpopKey();
  const travelGrant = await signIn(travel, 'Travel laptop');
  await signIn(await dpopKey(), 'Second laptop');
  await signIn(travel, 'Travel laptop');
  const signIns = await admin.query<{
    device_label: string;
    new_device: boolean;
    new_network: boolean;
    notice: boolean;
  }>(
    `SELECT device_label, new_device, new_network, notice_id IS NOT NULL AS notice
     FROM uts.sign_ins WHERE account_id = $1 ORDER BY signed_in_at`,
    [ACCOUNT]
  );
  console.log('sign-ins', JSON.stringify(signIns.rows));
  const fired = await noticesOf('new_device_network');
  check(
    'new device on a new network fires exactly once',
    fired.length === 1 && signIns.rows.filter(row => row.notice).length === 1
  );
  check(
    'the firing sign-in is the new device on the new network',
    signIns.rows[1]?.notice === true && signIns.rows[1].new_device && signIns.rows[1].new_network
  );

  // 2. Every kind, push then email, no link.
  const before = (await outbox()).length;
  const dispatched = await devPost('/__dev/notices/dispatch', { noticeId: fired[0].id });
  check('sign-in notice dispatched', dispatched.status === 200);

  const patId = randomUUID();
  await admin.query(
    `INSERT INTO uts.notices (account_id, kind, details) VALUES ($1, 'credential_created', $2)`,
    [ACCOUNT, { credential: 'pat', patId, scope: 'gateway:models.read' }]
  );
  const credential = await devPost('/__dev/notices/credential', {
    kind: 'pat_created',
    accountId: ACCOUNT,
    credentialId: patId,
  });
  check('credential notice port answered', credential.status === 200);

  const produced: [string, Record<string, unknown>][] = [
    [
      'sign_in_method_changed',
      { method: 'passkey', change: 'added', deviceLabel: 'Safari on macOS 14.1' },
    ],
    ['primary_email_changed', {}],
    ['device_sign_in_approved', { deviceLabel: 'Kilo CLI 1.2.3', country: 'DE', city: 'Berlin' }],
    ['ci_trust_policy_changed', {}],
    ['third_party_client_approved', { clientName: 'Visit evil.example/claim now' }],
    ['sessions_revoked', { actor: 'support' }],
    ['suspicious_sign_in', { country: 'FR' }],
    ['sign_in_code_stopped', {}],
    ['bot_key_flagged', { flaggedKeys: 2 }],
  ];
  for (const [kind, details] of produced) {
    const row = await admin.query<{ id: string }>(
      `INSERT INTO uts.notices (account_id, kind, details, old_email) VALUES ($1, $2, $3, $4) RETURNING id`,
      [ACCOUNT, kind, details, kind === 'primary_email_changed' ? 'previous@example.com' : null]
    );
    await devPost('/__dev/notices/dispatch', { noticeId: row.rows[0].id });
  }
  const sent = (await outbox()).slice(before);
  const kinds = await admin.query<{ id: string; kind: string; delivery: string }>(
    `SELECT id, kind, delivery FROM uts.notices WHERE account_id = $1 ORDER BY created_at`,
    [ACCOUNT]
  );
  for (const row of kinds.rows) {
    const attempts = await attemptsOf(row.id);
    const expected =
      row.kind === 'sign_in_code_stopped' ? ['1:push=sent'] : ['1:push=sent', '1:email=sent'];
    check(
      `${row.kind}: ${attempts.join(' ')} -> ${row.delivery}`,
      JSON.stringify(attempts) === JSON.stringify(expected) && row.delivery === 'delivered'
    );
  }
  check('11 kinds delivered', kinds.rows.length === 11, { kinds: kinds.rows.length });
  const texts = sent.flatMap(entry =>
    entry.channel === 'push'
      ? [entry.message.title, entry.message.body]
      : [entry.message.subject, entry.message.text]
  );
  check(
    'no message holds a link or an address',
    texts.every(text => !LINK_LIKE.test(text)),
    {
      messages: sent.length,
    }
  );
  check(
    'no message holds a device label, a platform or an app name the client chose',
    texts.every(text => !/laptop|linux|Safari|evil|Visit|claim/i.test(text))
  );
  const emailChange = sent.find(
    entry => entry.channel === 'email' && entry.message.subject.includes('email changed')
  );
  check(
    'an email change also goes to the previous address',
    emailChange?.channel === 'email' && emailChange.message.to.length === 2
  );
  const firstPush = sent.find(entry => entry.channel === 'push');
  console.log(
    'sample push',
    JSON.stringify(
      firstPush?.channel === 'push'
        ? { title: firstPush.message.title, body: firstPush.message.body }
        : null
    )
  );
  const firstEmail = sent.find(entry => entry.channel === 'email');
  console.log(
    'sample email subject',
    JSON.stringify(firstEmail?.channel === 'email' ? firstEmail.message.subject : null)
  );
  console.log(
    firstEmail?.channel === 'email' ? firstEmail.message.text.replaceAll(/^/gm, '  | ') : ''
  );

  // 3. A failed channel and the background pass.
  const retried = await admin.query<{ id: string }>(
    `INSERT INTO uts.notices (account_id, kind) VALUES ($1, 'sessions_revoked') RETURNING id`,
    [ACCOUNT]
  );
  const retryId = retried.rows[0].id;
  await devPost(
    '/__dev/notices/dispatch',
    { noticeId: retryId },
    { 'Kilo-Dev-Notice-Answers': 'push=no_target,email=retryable_failure' }
  );
  const pending = await admin.query<{ delivery: string }>(
    'SELECT delivery FROM uts.notices WHERE id = $1',
    [retryId]
  );
  check(
    'email failing retryably leaves the notice pending',
    pending.rows[0].delivery === 'pending'
  );
  await admin.query('UPDATE uts.notices SET next_attempt_at = now() WHERE id = $1', [retryId]);
  const sweep = await devPost('/__dev/notices/sweep', {});
  console.log('sweep', JSON.stringify(sweep.body));
  check(
    'the background pass retries email only and delivers it',
    JSON.stringify(await attemptsOf(retryId)) ===
      JSON.stringify(['1:push=no_target', '1:email=retryable_failure', '2:email=sent'])
  );

  // 4. The security view.
  const passSession = await admin.query<{ id: string }>(
    `INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
     VALUES ($1, $2, now(), '{passkey}', now() + interval '14 days', now() + interval '30 days') RETURNING id`,
    [ACCOUNT, randomBytes(32)]
  );
  const pass = await admin.query<{ id: string }>(
    `INSERT INTO uts.gate_passes (account_id, browser_session_id, tier, action, satisfied_by, expires_at)
     VALUES ($1, $2, 'b', 'pat_create', '{recent_sign_in}', now() + interval '10 minutes') RETURNING id`,
    [ACCOUNT, passSession.rows[0].id]
  );
  await admin.query(
    `INSERT INTO uts.personal_access_tokens (account_id, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
     VALUES ($1, 'e2e', $2, 'wxyz', 'gateway', 'gateway:models.read', $3, now() + interval '90 days')`,
    [ACCOUNT, randomBytes(32), pass.rows[0].id]
  );
  const viewHeaders = { 'Kilo-Dev-Account': ACCOUNT, 'Kilo-Dev-Grant': travelGrant.grantId };
  const viewResponse = await fetch(new URL(UTS_SECURITY_PATH.slice(1), base), {
    headers: viewHeaders,
  });
  const viewText = await viewResponse.text();
  const view = SecurityViewSchema.parse(JSON.parse(viewText));
  check('security view answers 200', viewResponse.status === 200);
  check('security view lists the sign-ins', view.sign_ins.length === 5, {
    signIns: view.sign_ins.length,
  });
  check('security view lists the live sessions', view.sessions.length >= 5, {
    sessions: view.sessions.length,
  });
  check(
    'security view lists the PAT',
    view.credentials.pats.some(pat => pat.name === 'e2e')
  );
  check(
    'security view lists the notices with their attempts',
    view.notices.length === 12 && view.notices.every(notice => notice.attempts.length > 0),
    {
      notices: view.notices.length,
    }
  );
  check(
    'security view holds no address and no email address',
    !/198\.51|203\.0\.113|@example\.com|127\.0\.0\.1/.test(viewText)
  );
  console.log(
    'view notices',
    JSON.stringify(
      view.notices.map(
        notice =>
          `${notice.kind}:${notice.delivery}:${notice.attempts.map(a => `${a.channel}=${a.outcome}`).join('/')}`
      )
    )
  );

  const revoked = await post('/revoke', { token: travelGrant.refreshToken, client_id: 'kilo-cli' });
  check('revoke answered', revoked.status === 200);
  const afterRevoke = await fetch(new URL(UTS_SECURITY_PATH.slice(1), base), {
    headers: viewHeaders,
  });
  check('security view refuses the revoked grant', afterRevoke.status === 401);

  await admin.end();
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
