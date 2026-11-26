/**
 * Local end-to-end run of the web BFF's browser sessions against `wrangler dev -c
 * wrangler.dev.jsonc` and the local identity store. The script is the browser (it keeps the
 * sign-in cookie and follows redirects by hand) and a stand-in `kilo-web` signer: it generates
 * the Ed25519 client key for the run and gives the Worker only its public half
 * (`KILO_WEB_CLIENT_JWKS`).
 *
 * 1. An email sign-in, then a CLI and a mobile grant of the same account on that session.
 * 2. `kilo-web` authorizes on its exact callback (code and `iss`, errors with `iss`), exchanges
 *    the code with a client assertion, and retries the exchange: the same session and handle.
 *    A replayed assertion, another audience and another verifier are refused.
 * 3. `read` and `token` (one scope, its exact resource origin) and their refusals.
 * 4. A step-up: a passkey step-up of the session, then a new authorization in it. The handle
 *    rotates, the session id stays, `auth_time` moves to the step-up, and the old handle and the
 *    old code's retry stop at once.
 * 5. One-device revoke: one CLI grant stops refreshing, the other CLI and the mobile grant keep it.
 * 6. `end`, its repeat, and a feed outage: 503 with `Retry-After`, then 200 on the retry.
 * 7. `end-all`: every browser session of the account ends, the CLI and mobile grants keep
 *    refreshing, and no subject-wide revocation is written.
 * 8. The legacy bridge with the flag on (fail-closed SSO provenance, replay, unknown user) and on
 *    a second Worker with the flag off.
 * 9. 429 `slow_down` with `Retry-After` past 60 calls a minute for one handle.
 * 10. The audit rows name no handle, code, assertion or token; then server-side timing.
 *
 * Synthetic data only: every key and secret is generated for the run, written to a 0600
 * `.dev.vars.bff-e2e` that `wrangler dev --env-file` reads and the run deletes, and never printed.
 *
 *   UTS_E2E_ADMIN_URL   admin login to the identity-store database (loopback only)
 *   UTS_E2E_APP_URL     app login to the same database, for the Worker's Hyperdrive binding
 *   UTS_E2E_PORT        first of the run's ports (default 9200): the Worker and its inspector,
 *                       then the bridge-off Worker and its inspector at +2 and +3
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  BrowserSessionEndAllSchema,
  BrowserSessionEndSchema,
  BrowserSessionGrantSchema,
  BrowserSessionReadSchema,
  BrowserSessionTokenSchema,
  DeviceRevokeSchema,
  LegacyBridgeGrantSchema,
  UTS_CLIENT_ASSERTION_TYPE,
  UTS_ENDPOINTS,
  UTS_JWT_TOKEN_TYPE,
} from '@kilocode/uts-contracts';
import {
  type JWTPayload,
  SignJWT,
  calculateJwkThumbprint,
  decodeJwt,
  exportJWK,
  generateKeyPair,
} from 'jose';
import pg from 'pg';
import { z } from 'zod';
import { isLoopbackHost } from './connection';

const adminUrl = z.url().parse(process.env.UTS_E2E_ADMIN_URL);
const appUrl = z.url().parse(process.env.UTS_E2E_APP_URL);
for (const url of [adminUrl, appUrl]) {
  if (!isLoopbackHost(new URL(url)))
    throw new Error('the end-to-end run uses a local database only');
}
const PORT = z.coerce
  .number()
  .int()
  .positive()
  .parse(process.env.UTS_E2E_PORT ?? '9200');
const base = `http://127.0.0.1:${PORT}`;
const bridgeOffBase = `http://127.0.0.1:${PORT + 2}`;
const issuer = UTS_ENDPOINTS.development.issuer;
const TOKEN_URL = `${issuer}/token`;
const WEB_REDIRECT = 'http://localhost:3000/api/auth/uts/callback';
const CLI_REDIRECT = 'http://127.0.0.1:4100/callback';
const MOBILE_REDIRECT = 'com.kilocode.kiloapp:/oauth/callback';
const DEVICE_SCOPES = 'session-sync:grants.exchange event-service:events.subscribe';
const BOOTSTRAP = 'uts:browser-session.read';

/** Every credential and address the run handles; none may appear in an audit row. */
const secrets: string[] = [];
const keep = <T extends string>(value: T): T => {
  secrets.push(value);
  return value;
};
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const b64 = (value: Buffer) => value.toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function log(step: string, detail: unknown) {
  console.log(`${step.padEnd(48)} ${JSON.stringify(detail)}`);
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`check failed: ${message}`);
}

// ---------------------------------------------------------------------------------------------
// The browser: the sign-in cookie of the Worker's origin, redirects followed by hand. The Worker
// names its own origin as the issuer (http://localhost:8800); requests to it go to `base`.

const jar = new Map<string, string>();

function storeCookies(response: Response) {
  const joined = response.headers.get('Set-Cookie');
  for (const header of joined === null ? [] : joined.split(/,\s*(?=__Host-)/)) {
    const [pair, ...attributes] = header.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const expired = attributes.some(attribute => attribute.trim().toLowerCase() === 'max-age=0');
    if (expired) jar.delete(name);
    else jar.set(name, keep(pair.slice(index + 1).trim()));
  }
}

let addressCount = 0;

async function browse(path: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(path.startsWith(issuer) ? path.slice(issuer.length) : path, base);
  const headers = new Headers(init.headers);
  addressCount += 1;
  headers.set('CF-Connecting-IP', `203.0.113.${(addressCount % 250) + 1}`);
  if (jar.size > 0) {
    headers.set('Cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
  }
  const response = await fetch(target, { ...init, headers, redirect: 'manual' });
  storeCookies(response);
  return response;
}

function formPost(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
    body: new URLSearchParams(fields).toString(),
  };
}

/** An email sign-in through the development mail port; the jar then holds a new session. */
async function emailSignIn(email: string): Promise<void> {
  jar.clear();
  const started = await browse(
    '/signin/email/start',
    formPost({ email, return_to: '/signin/done' })
  );
  check(started.status === 200, `email start ${started.status}`);
  const mail = await fetch(`${base}/__dev/mail?to=${encodeURIComponent(email)}`);
  const { code } = z.object({ code: z.string() }).parse(await mail.json());
  keep(code);
  const signedIn = await browse('/signin/email/code', formPost({ email, code }));
  check(signedIn.status === 303 && jar.has('__Host-uts_session'), 'email code signs in');
}

// ---------------------------------------------------------------------------------------------
// The stand-in `kilo-web` signer.

type WebKey = { privateKey: CryptoKey; kid: string; jwks: string };

async function webKey(): Promise<WebKey> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const { x } = await exportJWK(publicKey);
  if (x === undefined) throw new Error('no public key');
  const kid = `kilo-web-${await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x })}`;
  return {
    privateKey,
    kid,
    jwks: JSON.stringify({
      keys: [{ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid, x }],
    }),
  };
}

let KEY: WebKey;

async function signJwt(claims: JWTPayload, typ?: string): Promise<string> {
  return keep(
    await new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: KEY.kid, ...(typ === undefined ? {} : { typ }) })
      .sign(KEY.privateKey)
  );
}

async function assertion(audience: string, jti = `jti-${randomUUID()}`) {
  return {
    client_assertion_type: UTS_CLIENT_ASSERTION_TYPE,
    client_assertion: await signJwt({
      iss: 'kilo-web',
      sub: 'kilo-web',
      aud: audience,
      iat: now(),
      exp: now() + 120,
      jti,
    }),
  };
}

/** What a BFF call got back. */
type BffAnswer = { status: number; headers: Headers; body: unknown };

/** A BFF call: a form POST to the Worker (no cookie: the BFF talks to UTS server to server). */
async function bff(
  path: string,
  fields: Record<string, string>,
  target = base
): Promise<BffAnswer> {
  const response = await fetch(`${target}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  const body: unknown = await response.json();
  return { status: response.status, headers: response.headers, body };
}

const ErrorSchema = z.object({ error: z.string() });
const errorOf = (body: unknown) => ErrorSchema.safeParse(body).data?.error ?? '';

async function sessionCall(name: string, handle: string, extra: Record<string, string> = {}) {
  const path = `/account/browser-sessions/${name}`;
  return await bff(path, {
    ...(await assertion(`${issuer}${path}`)),
    session_handle: handle,
    ...extra,
  });
}

type WebAuthorization = { url: string; verifier: string };

function webAuthorization(extra: Record<string, string> = {}): WebAuthorization {
  const verifier = keep(randomBytes(32).toString('base64url'));
  const url = new URL('/authorize', base);
  for (const [name, value] of Object.entries({
    client_id: 'kilo-web',
    redirect_uri: WEB_REDIRECT,
    response_type: 'code',
    scope: BOOTSTRAP,
    resource: issuer,
    code_challenge: b64(sha256(verifier)),
    code_challenge_method: 'S256',
    state: randomUUID(),
    dev_handoff: 'signin',
    ...extra,
  })) {
    url.searchParams.set(name, value);
  }
  return { url: url.toString(), verifier };
}

/** The `kilo-web` code of an authorization on the jar's session. */
async function webCode(authorization: WebAuthorization): Promise<string> {
  const response = await browse(authorization.url);
  const location = new URL(response.headers.get('Location') ?? 'invalid:');
  check(
    response.status === 302 && `${location.origin}${location.pathname}` === WEB_REDIRECT,
    `kilo-web code redirect ${response.status}`
  );
  check(location.searchParams.get('iss') === issuer, 'iss on the code redirect');
  return keep(location.searchParams.get('code') ?? '');
}

async function exchange(code: string, verifier: string, jti?: string) {
  return await bff('/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: WEB_REDIRECT,
    code_verifier: verifier,
    ...(await assertion(TOKEN_URL, jti)),
  });
}

async function webSessionOf(authorization: WebAuthorization) {
  const result = await exchange(await webCode(authorization), authorization.verifier);
  check(result.status === 200, `code exchange ${result.status} ${errorOf(result.body)}`);
  const grant = BrowserSessionGrantSchema.parse(result.body);
  keep(grant.session_handle);
  for (const issued of grant.issued_tokens) keep(issued.access_token);
  return grant;
}

// ---------------------------------------------------------------------------------------------
// CLI and mobile grants of the same account, DPoP-bound.

async function dpop() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    jkt: await calculateJwkThumbprint(jwk, 'sha256'),
    proof: () =>
      new SignJWT({ jti: randomUUID(), htm: 'POST', htu: TOKEN_URL, iat: now() })
        .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk })
        .sign(privateKey),
  };
}

const DeviceTokenSchema = z.looseObject({ access_token: z.string(), refresh_token: z.string() });
type DeviceGrant = {
  clientId: string;
  refreshToken: string;
  sid: string;
  proof: () => Promise<string>;
};

async function deviceGrant(clientId: 'kilo-cli' | 'kilo-mobile'): Promise<DeviceGrant> {
  const verifier = keep(randomBytes(32).toString('base64url'));
  const key = await dpop();
  const redirect = clientId === 'kilo-cli' ? CLI_REDIRECT : MOBILE_REDIRECT;
  const url = new URL('/authorize', base);
  for (const [name, value] of Object.entries({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: DEVICE_SCOPES,
    code_challenge: b64(sha256(verifier)),
    code_challenge_method: 'S256',
    dpop_jkt: key.jkt,
    state: randomUUID(),
    dev_handoff: 'signin',
  })) {
    url.searchParams.set(name, value);
  }
  // A native redirect (loopback or private-use) needs the confirm page's same-origin POST
  // (RFC 8252 section 8.6).
  const response = await browse(url.toString(), { method: 'POST', headers: { Origin: base } });
  const location = new URL(response.headers.get('Location') ?? 'invalid:');
  check(response.status === 302, `${clientId} code redirect ${response.status}`);
  const code = keep(location.searchParams.get('code') ?? '');
  const tokens = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { DPoP: await key.proof() },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  check(tokens.status === 200, `${clientId} token ${tokens.status}`);
  const parsed = DeviceTokenSchema.parse(await tokens.json());
  keep(parsed.refresh_token);
  keep(parsed.access_token);
  return {
    clientId,
    refreshToken: parsed.refresh_token,
    sid: z.string().parse(decodeJwt(parsed.access_token).sid),
    proof: key.proof,
  };
}

async function refreshStatus(grant: DeviceGrant): Promise<number> {
  const response = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { DPoP: await grant.proof() },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: grant.refreshToken,
      client_id: grant.clientId,
      scope: 'event-service:events.subscribe',
    }),
  });
  const body: unknown = await response.json();
  const parsed = z.looseObject({ access_token: z.string() }).safeParse(body);
  if (parsed.success) keep(parsed.data.access_token);
  return response.status;
}

/** Wakes both feed objects: a one-second stop loads each one and starts its backfill alarm. */
async function stopFeeds(seconds: number) {
  for (const feed of [0, 1]) {
    const response = await fetch(`${base}/__dev/feed/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feed, seconds }),
    });
    check(response.status === 200, `feed ${feed} stop ${response.status}`);
  }
}

// ---------------------------------------------------------------------------------------------

async function run(admin: pg.Client) {
  // 1. An email sign-in, and a CLI and a mobile grant of the account on that session.
  const email = keep(`bff-${randomBytes(3).toString('hex')}@example.com`);
  await emailSignIn(email);
  const cliKept = await deviceGrant('kilo-cli');
  const cliRevoked = await deviceGrant('kilo-cli');
  const mobile = await deviceGrant('kilo-mobile');
  const account = await admin.query<{ id: string }>(
    'SELECT id FROM uts.accounts WHERE primary_email = $1',
    [email]
  );
  const accountId = account.rows[0].id;
  log('1 email sign-in, CLI x2 and mobile grants', {
    accountIdForm: accountId.slice(0, 4),
    cli: [cliKept.sid.slice(0, 8), cliRevoked.sid.slice(0, 8)],
    mobile: mobile.sid.slice(0, 8),
  });

  // 2. Authorize, exchange, retry.
  const errorRedirect = async (extra: Record<string, string>) => {
    const response = await browse(webAuthorization(extra).url);
    const location = new URL(response.headers.get('Location') ?? 'invalid:');
    return {
      status: response.status,
      error: location.searchParams.get('error'),
      iss: location.searchParams.get('iss') === issuer,
    };
  };
  const withDpop = await errorRedirect({ dpop_jkt: 'A'.repeat(43) });
  const withResource = await errorRedirect({ resource: 'http://localhost:3000' });
  const wrongRedirect = await browse(
    webAuthorization({ redirect_uri: 'http://localhost:3000/api/auth/uts/other' }).url
  );
  check(withDpop.error === 'invalid_request' && withDpop.iss, 'dpop_jkt refused with iss');
  check(withResource.error === 'invalid_target' && withResource.iss, 'resource refused with iss');
  check(
    wrongRedirect.status === 400 && wrongRedirect.headers.get('Location') === null,
    'no redirect'
  );

  const first = webAuthorization();
  const code = await webCode(first);
  const exchanged = await exchange(code, first.verifier);
  check(exchanged.status === 200, `exchange ${exchanged.status}`);
  check(exchanged.headers.get('Cache-Control') === 'no-store', 'no-store');
  const grant = BrowserSessionGrantSchema.parse(exchanged.body);
  keep(grant.session_handle);
  const claims = decodeJwt(grant.access_token);
  check(
    claims.sid === grant.session_id && claims.sub === accountId && grant.subject === accountId,
    'sid is the session id, sub the subject'
  );
  check(claims.client_id === 'kilo-web' && claims.aud === 'uts', 'kilo-web uts token');
  const retryJti = `jti-${randomUUID()}`;
  const retry = await exchange(code, first.verifier, retryJti);
  const retried = BrowserSessionGrantSchema.parse(retry.body);
  keep(retried.access_token);
  check(
    retried.session_handle === grant.session_handle &&
      retried.session_id === grant.session_id &&
      retried.issued_at === grant.issued_at &&
      retried.access_token !== grant.access_token,
    'a retry gets the same session and handle, a new token'
  );
  const replay = await exchange(code, first.verifier, retryJti);
  const otherVerifier = await exchange(code, keep(randomBytes(32).toString('base64url')));
  const wrongAudience = await bff('/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: WEB_REDIRECT,
    code_verifier: first.verifier,
    ...(await assertion(`${issuer}/account/browser-sessions/read`)),
  });
  check(replay.status === 401 && errorOf(replay.body) === 'invalid_client', 'replayed assertion');
  check(errorOf(otherVerifier.body) === 'invalid_grant', 'another verifier');
  check(errorOf(wrongAudience.body) === 'invalid_client', 'another audience');
  log('2 authorize, exchange, retry', {
    authorizeErrors: {
      dpop_jkt: withDpop.error,
      resource: withResource.error,
      wrongRedirect: wrongRedirect.status,
    },
    exchange: exchanged.status,
    response: Object.keys(grant).sort(),
    amr: grant.amr,
    retrySameHandle: retried.session_handle === grant.session_handle,
    replayedAssertion: `${replay.status} ${errorOf(replay.body)}`,
    otherVerifier: `${otherVerifier.status} ${errorOf(otherVerifier.body)}`,
    otherAudience: `${wrongAudience.status} ${errorOf(wrongAudience.body)}`,
  });

  // 3. read and token.
  const read = await sessionCall('read', grant.session_handle);
  const readBody = BrowserSessionReadSchema.parse(read.body);
  const unknownRead = await sessionCall('read', keep(randomBytes(32).toString('base64url')));
  const minted = await sessionCall('token', grant.session_handle, {
    scope: BOOTSTRAP,
    resource: issuer,
  });
  const mintedBody = BrowserSessionTokenSchema.parse(minted.body);
  keep(mintedBody.access_token);
  const otherScope = await sessionCall('token', grant.session_handle, {
    scope: 'kilo-api:profile.read',
    resource: 'http://localhost:3000',
  });
  const otherResource = await sessionCall('token', grant.session_handle, {
    scope: BOOTSTRAP,
    resource: 'http://localhost:3000',
  });
  check(readBody.session_id === grant.session_id && readBody.subject === accountId, 'read');
  check(unknownRead.status === 401 && errorOf(unknownRead.body) === 'invalid_session', 'unknown');
  check(decodeJwt(mintedBody.access_token).sid === grant.session_id, 'token sid');
  check(errorOf(otherScope.body) === 'invalid_scope', 'scope not for kilo-web');
  check(errorOf(otherResource.body) === 'invalid_target', 'resource of another audience');
  log('3 read and token', {
    read: read.status,
    readFields: Object.keys(readBody).sort(),
    unknownHandle: `${unknownRead.status} ${errorOf(unknownRead.body)}`,
    token: `${minted.status} ${mintedBody.scope} ${mintedBody.expires_in}s`,
    otherScope: `${otherScope.status} ${errorOf(otherScope.body)}`,
    otherResource: `${otherResource.status} ${errorOf(otherResource.body)}`,
  });

  // 4. Step-up: a passkey step-up of the session (the passkey ceremony's row, seeded as the
  // owner), then a new authorization in the same session.
  // A second passes, so the step-up is later than the sign-in.
  await sleep(1100);
  const pass = await admin.query<{ id: string }>(
    `INSERT INTO uts.gate_passes (account_id, browser_session_id, tier, action, satisfied_by, expires_at)
     VALUES ($1, $2, 'a', 'passkey_add', '{recent_sign_in,email_code}', now() + interval '10 minutes')
     RETURNING id`,
    [accountId, grant.session_id]
  );
  const passkey = await admin.query<{ id: string }>(
    `INSERT INTO uts.passkey_credentials (account_id, credential_id, public_key, backup_eligible,
       backed_up, rp_id, name, user_handle, gate_pass_id)
     VALUES ($1, $2, $3, false, false, 'localhost', 'e2e', $4, $5) RETURNING id`,
    [accountId, randomBytes(32), randomBytes(32), randomBytes(32), pass.rows[0].id]
  );
  const stepUp = await admin.query<{ completed_at: Date }>(
    `INSERT INTO uts.step_ups (account_id, browser_session_id, purpose, passkey_credential_id, expires_at)
     VALUES ($1, $2, 'gate', $3, now() + interval '10 minutes') RETURNING completed_at`,
    [accountId, grant.session_id, passkey.rows[0].id]
  );
  await sleep(1100);
  const stepped = await webSessionOf(webAuthorization());
  const oldRead = await sessionCall('read', grant.session_handle);
  const oldRetry = await exchange(code, first.verifier);
  // A sign-out with the replaced handle is refused, and the session lives on under the new one.
  const oldEnd = await sessionCall('end', grant.session_handle);
  const newRead = await sessionCall('read', stepped.session_handle);
  check(oldEnd.status === 401 && errorOf(oldEnd.body) === 'invalid_session', 'old handle end');
  check(newRead.status === 200, 'new handle still live');
  check(stepped.session_id === grant.session_id, 'same session id');
  check(stepped.session_handle !== grant.session_handle, 'new handle');
  check(stepped.issued_at > grant.issued_at, 'issued_at moved');
  check(
    stepped.auth_time === Math.floor(stepUp.rows[0].completed_at.getTime() / 1000),
    'auth_time'
  );
  check(stepped.amr.includes('passkey'), 'amr includes passkey');
  check(oldRead.status === 401 && errorOf(oldRead.body) === 'invalid_session', 'old handle dead');
  check(errorOf(oldRetry.body) === 'invalid_grant', 'old code retry refused');
  log('4 step-up rotation', {
    sameSessionId: stepped.session_id === grant.session_id,
    handleRotated: stepped.session_handle !== grant.session_handle,
    issuedAt: `${grant.issued_at} -> ${stepped.issued_at}`,
    authTime: `${grant.auth_time} -> ${stepped.auth_time}`,
    amr: stepped.amr,
    oldHandleRead: `${oldRead.status} ${errorOf(oldRead.body)}`,
    oldCodeRetry: `${oldRetry.status} ${errorOf(oldRetry.body)}`,
    oldHandleEnd: `${oldEnd.status} ${errorOf(oldEnd.body)}`,
    newHandleRead: newRead.status,
  });

  // Wake the feed objects so a vouching one takes the revocations below.
  await stopFeeds(1);
  await sleep(12_000);

  // 5. One-device revoke.
  const deviceSessionOf = await admin.query<{ device_session_id: string }>(
    'SELECT device_session_id FROM uts.refresh_grants WHERE id = $1',
    [cliRevoked.sid]
  );
  const revoked = await bff('/account/devices/revoke', {
    ...(await assertion(`${issuer}/account/devices/revoke`)),
    session_handle: stepped.session_handle,
    sid: deviceSessionOf.rows[0].device_session_id,
  });
  const foreign = await bff('/account/devices/revoke', {
    ...(await assertion(`${issuer}/account/devices/revoke`)),
    session_handle: stepped.session_handle,
    sid: randomUUID(),
  });
  DeviceRevokeSchema.parse(revoked.body);
  const afterRevoke = {
    revoked: await refreshStatus(cliRevoked),
    cliKept: await refreshStatus(cliKept),
    mobile: await refreshStatus(mobile),
  };
  check(revoked.status === 200 && foreign.status === 200, 'device revoke answers 200');
  check(
    afterRevoke.revoked === 400 && afterRevoke.cliKept === 200 && afterRevoke.mobile === 200,
    'one device'
  );
  const grantEntry = await admin.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM uts.revocations WHERE kind = 'grant' AND subject_id = $1`,
    [cliRevoked.sid]
  );
  check(grantEntry.rows[0].count === 1, 'one grant feed entry');
  log('5 one-device revoke', {
    revoke: revoked.status,
    foreignSid: foreign.status,
    refreshAfter: afterRevoke,
  });

  // 6. end, its repeat, and a feed outage.
  await emailSignIn(email);
  const second = await webSessionOf(webAuthorization());
  const ended = await sessionCall('end', second.session_handle);
  const endedBody = BrowserSessionEndSchema.parse(ended.body);
  const repeated = await sessionCall('end', second.session_handle);
  const secondRead = await sessionCall('read', second.session_handle);
  const stillLive = await sessionCall('read', stepped.session_handle);
  check(endedBody.session_id === second.session_id, 'end names the session');
  check(JSON.stringify(repeated.body) === '{"status":"ended"}', 'repeat without session_id');
  check(secondRead.status === 401 && stillLive.status === 200, 'only that session ended');

  await emailSignIn(email);
  const third = await webSessionOf(webAuthorization());
  await stopFeeds(8);
  const during = await sessionCall('end', third.session_handle);
  await sleep(9_000);
  const after = await sessionCall('end', third.session_handle);
  check(
    during.status === 503 && during.headers.get('Retry-After') !== null,
    '503 with Retry-After'
  );
  check(after.status === 200, 'retry after the outage');
  log('6 end, repeat, feed outage', {
    end: `${ended.status} ${JSON.stringify(endedBody)}`.replace(second.session_id, '<session>'),
    repeat: `${repeated.status} ${JSON.stringify(repeated.body)}`,
    endedHandleRead: secondRead.status,
    otherSessionRead: stillLive.status,
    duringOutage: `${during.status} ${errorOf(during.body)} Retry-After ${during.headers.get('Retry-After')}`,
    afterOutage: `${after.status} ${JSON.stringify(after.body)}`,
  });

  // 7. end-all.
  await emailSignIn(email);
  const fourth = await webSessionOf(webAuthorization());
  const live = await admin.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM uts.browser_sessions WHERE account_id = $1 AND status = 'active'`,
    [accountId]
  );
  const endAll = await sessionCall('end-all', stepped.session_handle);
  const endAllBody = BrowserSessionEndAllSchema.parse(endAll.body);
  const endAllRepeat = BrowserSessionEndAllSchema.parse(
    (await sessionCall('end-all', stepped.session_handle)).body
  );
  const reads = [
    (await sessionCall('read', stepped.session_handle)).status,
    (await sessionCall('read', fourth.session_handle)).status,
  ];
  const deviceRefresh = { cli: await refreshStatus(cliKept), mobile: await refreshStatus(mobile) };
  const subjectRows = await admin.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM uts.revocations WHERE kind = 'subject' AND subject_id = $1`,
    [accountId]
  );
  const activeGrants = await admin.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM uts.refresh_grants WHERE account_id = $1 AND status = 'active'`,
    [accountId]
  );
  check(endAllBody.ended === live.rows[0].count && endAllBody.ended >= 2, 'every browser session');
  check(endAllRepeat.ended === 0, 'repeat ends nothing');
  check(
    reads.every(status => status === 401),
    'both handles dead'
  );
  check(deviceRefresh.cli === 200 && deviceRefresh.mobile === 200, 'CLI and mobile untouched');
  check(subjectRows.rows[0].count === 0, 'no subject-wide revocation');
  log('7 end-all', {
    liveBrowserSessionsBefore: live.rows[0].count,
    endAll: `${endAll.status} ${JSON.stringify(endAllBody)}`,
    repeat: JSON.stringify(endAllRepeat),
    handleReadsAfter: reads,
    deviceRefreshAfter: deviceRefresh,
    activeDeviceGrants: activeGrants.rows[0].count,
    subjectRevocations: subjectRows.rows[0].count,
  });

  // 8. The legacy bridge.
  const appUser = `app-user-${randomBytes(6).toString('hex')}`;
  await admin.query('INSERT INTO uts.accounts (id, primary_email) VALUES ($1, $2)', [
    appUser,
    keep(`legacy-${randomBytes(3).toString('hex')}@example.com`),
  ]);
  const legacyAuthTime = now() - 3 * 86_400;
  const subjectToken = async (sub: string, claims: JWTPayload = {}) =>
    await signJwt(
      {
        iss: 'kilo-web',
        sub,
        aud: TOKEN_URL,
        iat: now(),
        exp: now() + 30,
        jti: `legacy-${randomUUID()}`,
        auth_time: legacyAuthTime,
        ...claims,
      },
      'kilo-legacy-session+jwt'
    );
  const bridgeFields = async (token: string) => ({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: token,
    subject_token_type: UTS_JWT_TOKEN_TYPE,
    ...(await assertion(TOKEN_URL)),
  });
  const ssoToken = await subjectToken(appUser, {
    sso_connection: 'conn_e2e',
    sso_organization: 'org_e2e',
  });
  const bridged = await bff('/token', await bridgeFields(ssoToken));
  const bridgedBody = LegacyBridgeGrantSchema.parse(bridged.body);
  keep(bridgedBody.session_handle);
  keep(bridgedBody.access_token);
  const bridgedRead = BrowserSessionReadSchema.parse(
    (await sessionCall('read', bridgedBody.session_handle)).body
  );
  const replayedSubject = await bff('/token', await bridgeFields(ssoToken));
  const unknownUser = await bff(
    '/token',
    await bridgeFields(await subjectToken(`app-user-${randomUUID()}`))
  );
  const bridgeOff = await bff(
    '/token',
    await bridgeFields(await subjectToken(appUser)),
    bridgeOffBase
  );
  check(
    bridgedBody.subject === appUser &&
      JSON.stringify(bridgedBody.amr) === '["legacy_session"]' &&
      bridgedBody.auth_time === legacyAuthTime &&
      bridgedBody.sso_connection === undefined,
    'bridge: legacy_session, legacy auth_time, no unconfirmed SSO'
  );
  check(bridgedRead.subject === appUser, 'bridged session reads');
  check(errorOf(replayedSubject.body) === 'invalid_grant', 'subject token replay');
  check(errorOf(unknownUser.body) === 'invalid_grant', 'unknown user');
  check(
    bridgeOff.status === 400 && errorOf(bridgeOff.body) === 'unsupported_grant_type',
    'flag off'
  );
  const bridgedSignIns = await admin.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM uts.sign_ins WHERE account_id = $1',
    [appUser]
  );
  check(bridgedSignIns.rows[0].count === 0, 'a bridge is not a recorded sign-in');
  log('8 legacy bridge', {
    flagOn: `${bridged.status} amr ${JSON.stringify(bridgedBody.amr)} sso ${bridgedBody.sso_connection ?? 'absent'}`,
    authTimeIsLegacy: bridgedBody.auth_time === legacyAuthTime,
    issuedTokenType: bridgedBody.issued_token_type,
    read: bridgedRead.status,
    replayedSubjectToken: `${replayedSubject.status} ${errorOf(replayedSubject.body)}`,
    unknownUser: `${unknownUser.status} ${errorOf(unknownUser.body)}`,
    flagOff: `${bridgeOff.status} ${errorOf(bridgeOff.body)}`,
    recordedSignIns: bridgedSignIns.rows[0].count,
  });

  // 9. The per-handle limit.
  const statuses: number[] = [];
  let limited: BffAnswer | null = null;
  // The handle made one call above (the bridged read), so its 60th call here is the 61st.
  for (let index = 0; index < 60; index += 1) {
    const result = await sessionCall('read', bridgedBody.session_handle);
    statuses.push(result.status);
    limited = result;
  }
  check(
    statuses.slice(0, 59).every(status => status === 200) &&
      limited?.status === 429 &&
      errorOf(limited.body) === 'slow_down' &&
      limited.headers.get('Retry-After') !== null,
    '429 slow_down with Retry-After past 60 a minute'
  );
  log('9 per-handle limit', {
    first60: [...new Set([200, ...statuses.slice(0, 59)])],
    call61: `${limited?.status} ${errorOf(limited?.body)} Retry-After ${limited?.headers.get('Retry-After')}`,
  });

  // 10. Audit rows, then timing.
  const rows = await admin.query<{ event_type: string; outcome: string; text: string }>(
    `SELECT event_type, event #>> '{data,outcome}' AS outcome, event::text AS text
     FROM uts.audit_events WHERE account_id IN ($1, $2) ORDER BY id`,
    [accountId, appUser]
  );
  const counts: Record<string, number> = {};
  for (const row of rows.rows) {
    const key = `${row.event_type} ${row.outcome}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const leaked = secrets.filter(
    value => value.length >= 12 && rows.rows.some(row => row.text.includes(value))
  );
  check(leaked.length === 0, `${leaked.length} secret values in audit rows`);
  log('10 audit rows (type outcome: count)', counts);
  log('10 values checked against audit rows', { values: secrets.length, found: leaked.length });

  await emailSignIn(email);
  const timed = await webSessionOf(webAuthorization());
  const time = async (work: () => Promise<{ status: number }>) => {
    const durations: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const began = performance.now();
      check((await work()).status === 200, 'timed call');
      durations.push(performance.now() - began);
    }
    durations.sort((left, right) => left - right);
    return { p50: Number(durations[9].toFixed(1)), p95: Number(durations[18].toFixed(1)) };
  };
  log('timing (ms, 20 calls, wall time from the script)', {
    read: await time(() => sessionCall('read', timed.session_handle)),
    token: await time(() =>
      sessionCall('token', timed.session_handle, { scope: BOOTSTRAP, resource: issuer })
    ),
  });
}

async function main() {
  KEY = await webKey();
  const vars = {
    SIGNIN_EMAIL_HASH_KEY: keep(randomBytes(32).toString('base64url')),
    KILO_WEB_CLIENT_JWKS: KEY.jwks,
  };
  writeFileSync(
    '.dev.vars.bff-e2e',
    Object.entries(vars)
      .map(([name, value]) => `${name}='${value}'`)
      .join('\n'),
    { mode: 0o600 }
  );
  const worker = (port: number, bridge: 'true' | 'false'): ChildProcess =>
    spawn(
      './node_modules/.bin/wrangler',
      [
        'dev',
        '-c',
        'wrangler.dev.jsonc',
        '--env-file',
        '.dev.vars.bff-e2e',
        '--port',
        String(port),
        '--inspector-port',
        String(port + 1),
        '--persist-to',
        `/tmp/uts-bff-e2e-${port}`,
        '--var',
        `WEBAUTHN_ORIGINS:http://localhost:${port}`,
        '--var',
        `LEGACY_BRIDGE_ENABLED:${bridge}`,
      ],
      {
        env: {
          ...process.env,
          // The PAT and replica bindings need a URL too; this run reads neither.
          CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE: appUrl,
          CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE_PAT: appUrl,
          CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE_REPLICA: appUrl,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
  const workers = [worker(PORT, 'true'), worker(PORT + 2, 'false')];
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    for (const target of [base, bridgeOffBase]) {
      for (let attempt = 0; ; attempt += 1) {
        const ready = await fetch(`${target}/.well-known/oauth-authorization-server`).catch(
          () => null
        );
        if (ready?.ok) break;
        if (attempt > 90) throw new Error('wrangler dev did not start');
        await sleep(1000);
      }
    }
    await admin.connect();
    await admin.query('SET ROLE uts_owner');
    await run(admin);
    console.log('bff e2e: all checks passed');
  } finally {
    for (const child of workers) child.kill('SIGTERM');
    rmSync('.dev.vars.bff-e2e', { force: true });
    await admin.end().catch(() => undefined);
  }
}

await main();
