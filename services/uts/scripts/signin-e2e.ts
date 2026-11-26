/**
 * Local end-to-end run of the sign-in surface against `wrangler dev -c wrangler.dev.jsonc` and the
 * identity store (README, "Local development"), with Chromium and a WebAuthn virtual
 * authenticator (CDP `WebAuthn` domain):
 *
 * 1. passkey registration on the passkeys page of a seeded browser session with a tier A pass;
 * 2. passkey sign-in on the sign-in page of the mobile app's authorization request, then its
 *    confirm page, the native code exchange with PKCE and DPoP, and the mobile refresh lifetime
 *    (60 days idle, 1 year);
 * 3. the confirm page that every native request on a session shows, the CLI's loopback request
 *    (whose plain GET gives no code) and the mobile app's alike, and the CLI's code on Continue;
 * 4. the RFC 8628 device grant: authorization, pending and slow_down polls; a code in the URL
 *    only fills the page and a cross-site POST is refused; approval of a typed code on the recent
 *    sign-in, and of a code from the link with a passkey step-up (tier B); and the token;
 * 5. a one-time ticket: mint from the mobile grant, redeem once, refuse the second use;
 * 6. the audit rows, which name every credential by reference only.
 *
 * Synthetic data only. It prints ids and outcomes, never a credential value.
 *
 *   UTS_E2E_BASE_URL    the mint Worker, such as http://localhost:8980 (its origin must be in
 *                       WEBAUTHN_ORIGINS)
 *   UTS_E2E_ADMIN_URL   admin login to the identity-store database (loopback only)
 *   UTS_E2E_CHROMIUM    a Chromium executable, when Playwright's own is not installed
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { UTS_ENDPOINTS } from '@kilocode/uts-contracts';
import { SignJWT, calculateJwkThumbprint, decodeJwt, exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import { type Page, chromium } from 'playwright';
import { z } from 'zod';
import { isLoopbackHost } from './connection';

const base = new URL(z.url().parse(process.env.UTS_E2E_BASE_URL));
const adminUrl = z.url().parse(process.env.UTS_E2E_ADMIN_URL);
if (!isLoopbackHost(new URL(adminUrl)) || !isLoopbackHost(base)) {
  throw new Error('the end-to-end run uses a local Worker and database only');
}
const chromiumPath = process.env.UTS_E2E_CHROMIUM;

const issuer = UTS_ENDPOINTS.development.issuer;
const ACCOUNT = `e2e:passkey-${randomUUID()}`;
const MOBILE_REDIRECT = 'com.kilocode.kiloapp:/oauth/callback';
const CLI_REDIRECT = 'http://127.0.0.1:4100/callback';
/** Scopes the registry gives both the CLI and the mobile app. */
const SCOPES = 'session-sync:grants.exchange event-service:events.subscribe';
const DAY_SECONDS = 86_400;

/** Every credential value the run handles; none may appear in an audit row. */
const secrets: string[] = [];
const sha256 = (value: string) => createHash('sha256').update(value).digest();

function log(step: string, detail: unknown) {
  console.log(`${step.padEnd(40)} ${JSON.stringify(detail)}`);
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`check failed: ${message}`);
}

const TokenSchema = z.looseObject({
  access_token: z.string(),
  issued_tokens: z.array(
    z.object({ access_token: z.string(), audience: z.string(), scope: z.string() })
  ),
  refresh_token: z.string().optional(),
  refresh_token_expires_in: z.number().optional(),
});
const ErrorSchema = z.looseObject({ error: z.string() });
const DeviceAuthorizationSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});

async function dpop() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    jkt: await calculateJwkThumbprint(jwk, 'sha256'),
    proof: (path: string) =>
      new SignJWT({
        jti: randomUUID(),
        htm: 'POST',
        htu: `${issuer}${path}`,
        iat: Math.floor(Date.now() / 1000),
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk })
        .sign(privateKey),
  };
}

async function post(path: string, fields: Record<string, string>, proof?: string) {
  const response = await fetch(new URL(path, base), {
    method: 'POST',
    body: new URLSearchParams(fields),
    headers: proof === undefined ? {} : { DPoP: proof },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

function authorizeUrl(params: Record<string, string>): string {
  const url = new URL('/authorize', base);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set('dev_handoff', 'signin');
  return url.toString();
}

/**
 * Opens `url`; resolves with the code of the authorization redirect it ends in. `signIn` clicks
 * the passkey sign-in, and `confirm` the confirm page every native (loopback or private-use) client
 * gets.
 */
async function codeFrom(page: Page, url: string, signIn: boolean, confirm = false): Promise<URL> {
  const redirect = page.waitForResponse(
    response => new URL(response.url()).pathname === '/authorize' && response.status() === 302,
    { timeout: 30_000 }
  );
  await page.goto(url).catch(() => undefined);
  if (signIn) {
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  }
  if (confirm) {
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  const response = await redirect;
  return new URL(z.string().parse(response.headers().location));
}

async function seed(admin: pg.Client) {
  await admin.query('SET ROLE uts_owner');
  await admin.query(
    `INSERT INTO uts.accounts (id, primary_email) VALUES ($1, 'passkey-e2e@example.com')`,
    [ACCOUNT]
  );
  // A session from another sign-in method, which the sign-in slice writes, and the tier A pass
  // for adding a passkey, which the gate slice opens.
  const cookie = randomBytes(32).toString('base64url');
  secrets.push(cookie);
  const session = await admin.query<{ id: string }>(
    `INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
     VALUES ($1, $2, now(), '{oauth}', now() + interval '14 days', now() + interval '30 days') RETURNING id`,
    [ACCOUNT, sha256(cookie)]
  );
  const pass = await admin.query<{ id: string }>(
    `INSERT INTO uts.gate_passes (account_id, browser_session_id, tier, action, satisfied_by, expires_at)
     VALUES ($1, $2, 'a', 'passkey_add', '{recent_sign_in,email_code}', now() + interval '10 minutes')
     RETURNING id`,
    [ACCOUNT, session.rows[0].id]
  );
  return { cookie, passId: pass.rows[0].id };
}

async function main() {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const { cookie, passId } = await seed(admin);

  const browser = await chromium.launch(
    chromiumPath === undefined ? {} : { executablePath: chromiumPath }
  );
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  page.on('pageerror', error => console.error(`page error: ${error.message}`));

  // 1. Register a passkey in the seeded session. Cookies are scoped by host, not port or scheme;
  // Chromium takes a Secure cookie for localhost only through an https URL, and sends it to
  // http://localhost, which counts as secure.
  await context.addCookies([
    {
      name: '__Host-uts_session',
      value: cookie,
      url: `https://${base.hostname}/`,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.goto(new URL('/signin/passkeys', base).toString());
  await page.getByLabel('Passkey name').fill('E2E authenticator');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await page.getByText('Passkey added.').waitFor({ timeout: 15_000 });
  const credentials = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  const registered = await admin.query<{ id: string; rp_id: string; pass: string }>(
    `SELECT passkey.id, passkey.rp_id, pass.status AS pass
     FROM uts.passkey_credentials AS passkey JOIN uts.gate_passes AS pass ON pass.id = passkey.gate_pass_id
     WHERE passkey.account_id = $1`,
    [ACCOUNT]
  );
  check(
    registered.rows.length === 1 && registered.rows[0].pass === 'consumed',
    'one passkey, pass consumed'
  );
  check(
    credentials.credentials.length === 1 && credentials.credentials[0].isResidentCredential,
    'resident key'
  );
  log('1 passkey registered', {
    passkeyId: registered.rows[0].id,
    rpId: registered.rows[0].rp_id,
    gatePass: `${passId} ${registered.rows[0].pass}`,
    authenticatorCredentials: credentials.credentials.length,
    signCount: credentials.credentials[0].signCount,
  });

  // 2. Sign in with the passkey on the mobile app's authorization request (no session).
  await context.clearCookies();
  const mobile = await dpop();
  const verifier = randomBytes(32).toString('base64url');
  const mobileRedirect = await codeFrom(
    page,
    authorizeUrl({
      response_type: 'code',
      client_id: 'kilo-mobile',
      redirect_uri: MOBILE_REDIRECT,
      code_challenge: sha256(verifier).toString('base64url'),
      code_challenge_method: 'S256',
      scope: SCOPES,
      state: 'mobile-e2e',
      dpop_jkt: mobile.jkt,
    }),
    true,
    true
  );
  const code = z.string().parse(mobileRedirect.searchParams.get('code'));
  secrets.push(code);
  check(
    `${mobileRedirect.protocol}${mobileRedirect.pathname}` === MOBILE_REDIRECT,
    'mobile redirect'
  );
  check(mobileRedirect.searchParams.get('iss') === issuer, 'iss in the response');
  const sessions = await admin.query<{ amr: string; count: number }>(
    `SELECT amr::text, count(*)::int AS count FROM uts.browser_sessions WHERE account_id = $1 GROUP BY amr`,
    [ACCOUNT]
  );
  log('2 passkey sign-in -> code', {
    redirect: `${mobileRedirect.protocol}${mobileRedirect.pathname}`,
    state: mobileRedirect.searchParams.get('state'),
    sessions: sessions.rows,
  });

  const exchanged = await post(
    '/token',
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: MOBILE_REDIRECT,
      client_id: 'kilo-mobile',
      code_verifier: verifier,
      device_label: 'E2E phone',
      device_platform: 'ios',
    },
    await mobile.proof('/token')
  );
  const mobileTokens = TokenSchema.parse(exchanged.body);
  const mobileGrant = z.string().parse(mobileTokens.refresh_token);
  secrets.push(mobileGrant, ...mobileTokens.issued_tokens.map(item => item.access_token));
  const claims = decodeJwt(mobileTokens.access_token);
  const lifetime = await admin.query<{ client_class: string; idle_days: number; max_days: number }>(
    `SELECT client_class,
            round(extract(epoch FROM idle_expires_at - created_at) / 86400)::int AS idle_days,
            round(extract(epoch FROM expires_at - created_at) / 86400)::int AS max_days
     FROM uts.refresh_grants WHERE id = $1`,
    [z.string().parse(claims.sid)]
  );
  const refreshDays = (mobileTokens.refresh_token_expires_in ?? 0) / DAY_SECONDS;
  check(exchanged.status === 200 && Math.round(refreshDays) === 60, 'mobile refresh 60 days idle');
  check(
    lifetime.rows[0]?.max_days === 365 && lifetime.rows[0].idle_days === 60,
    'mobile grant 60 d / 1 y'
  );
  check(JSON.stringify(claims.amr) === '["passkey"]', 'amr passkey');
  log('2 native token (PKCE + DPoP)', {
    status: exchanged.status,
    refreshExpiresInDays: Number(refreshDays.toFixed(3)),
    grant: lifetime.rows[0],
    jtis: mobileTokens.issued_tokens.map(item => decodeJwt(item.access_token).jti),
    amr: claims.amr,
  });
  const refreshed = await post(
    '/token',
    {
      grant_type: 'refresh_token',
      refresh_token: mobileGrant,
      client_id: 'kilo-mobile',
      scope: 'event-service:events.subscribe',
    },
    await mobile.proof('/token')
  );
  const refreshedTokens = TokenSchema.parse(refreshed.body);
  secrets.push(...refreshedTokens.issued_tokens.map(item => item.access_token));
  log('2 native refresh (DPoP)', {
    status: refreshed.status,
    scope: refreshedTokens.issued_tokens[0].scope,
  });
  check(refreshed.status === 200, 'mobile refresh');

  // 3. The CLI's loopback request, like the mobile client's, shows the confirm page on the
  // session however recent the sign-in is (RFC 8252 section 8.6), and completes on Continue.
  const cli = await dpop();
  const cliVerifier = randomBytes(32).toString('base64url');
  const cliUrl = authorizeUrl({
    response_type: 'code',
    client_id: 'kilo-cli',
    redirect_uri: CLI_REDIRECT,
    code_challenge: sha256(cliVerifier).toString('base64url'),
    code_challenge_method: 'S256',
    scope: 'event-service:events.subscribe',
    state: 'cli-e2e',
    dpop_jkt: cli.jkt,
  });
  const cliGet = await context.request.get(cliUrl, { maxRedirects: 0 });
  const cliPage = /<title>([^<]*)<\/title>/.exec(await cliGet.text())?.[1];
  check(
    cliGet.status() === 200 && cliPage === 'Continue to the app',
    'a CLI GET shows the confirm page, not a code'
  );
  // The confirm page's Continue is a same-origin form POST of the same URL; the browser click on
  // it is step 2's mobile request, so here the request context sends that POST itself.
  const confirmed = await context.request.post(cliUrl, {
    headers: { Origin: base.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    data: '',
    maxRedirects: 0,
  });
  const cliRedirect = new URL(z.string().parse(confirmed.headers().location));
  check(
    confirmed.status() === 302 &&
      `${cliRedirect.origin}${cliRedirect.pathname}` === CLI_REDIRECT &&
      cliRedirect.searchParams.get('code') !== null,
    'the confirm POST redirects to the CLI with a code'
  );
  secrets.push(z.string().parse(cliRedirect.searchParams.get('code')));
  log('3 CLI loopback on the session', {
    plainGet: { status: cliGet.status(), page: cliPage },
    confirmPost: {
      status: confirmed.status(),
      redirect: `${cliRedirect.origin}${cliRedirect.pathname}`,
    },
  });
  // The request context shares the page's cookies and follows no redirect.
  const stale = await context.request.get(
    authorizeUrl({
      response_type: 'code',
      client_id: 'kilo-mobile',
      redirect_uri: MOBILE_REDIRECT,
      code_challenge: sha256(verifier).toString('base64url'),
      code_challenge_method: 'S256',
      scope: SCOPES,
      dpop_jkt: mobile.jkt,
    }),
    { maxRedirects: 0 }
  );
  const stalePage = /<title>([^<]*)<\/title>/.exec(await stale.text())?.[1];
  check(
    stale.status() === 200 && stalePage === 'Continue to the app',
    'mobile request shows a page'
  );
  log('3 mobile request on a live session', { status: stale.status(), page: stalePage });
  await page.goto('about:blank');

  // 4. Device grant: the CLI asks, polls, the user approves on the device page.
  const authorize = async () => {
    const started = await post('/device_authorization', {
      client_id: 'kilo-cli',
      scope: 'event-service:events.subscribe',
    });
    check(started.status === 200, 'device authorization');
    const parsed = DeviceAuthorizationSchema.parse(started.body);
    secrets.push(parsed.device_code, parsed.user_code);
    return parsed;
  };
  const approval = async (deviceCode: string) =>
    (
      await admin.query<{ status: string; amr: string; satisfied_by: string; step_ups: number }>(
        `SELECT code.status, code.amr::text, pass.satisfied_by::text,
                (SELECT count(*)::int FROM uts.step_ups WHERE account_id = $1) AS step_ups
         FROM uts.device_codes AS code JOIN uts.gate_passes AS pass ON pass.id = code.gate_pass_id
         WHERE code.device_code_hash = $2`,
        [ACCOUNT, sha256(deviceCode)]
      )
    ).rows[0];

  // A typed code: the sign-in of step 2 is under 10 minutes old, which tier B accepts.
  const typed = await authorize();
  await page.goto(new URL('/device', base).toString());
  await page.getByLabel('Code shown on your device').fill(typed.user_code.toLowerCase());
  await page.getByRole('button', { name: 'Continue' }).click();
  const typedSource = await page.locator('#device-user-code').getAttribute('data-code-source');
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByText('Device approved.', { exact: false }).waitFor({ timeout: 20_000 });
  const typedApproval = await approval(typed.device_code);
  check(
    typedSource === 'typed' && typedApproval?.satisfied_by === '{recent_sign_in}',
    'typed code approved on the recent sign-in'
  );
  log('4 typed code (recent sign-in, tier B)', { source: typedSource, ...typedApproval });

  const device = await dpop();
  const authorization = await authorize();
  log('4 device authorization', {
    userCodeShape: authorization.user_code.replace(/[A-Z]/g, 'X'),
    verification: authorization.verification_uri,
    expiresIn: authorization.expires_in,
    interval: authorization.interval,
  });
  const poll = async () =>
    await post(
      '/token',
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: authorization.device_code,
        client_id: 'kilo-cli',
        device_label: 'E2E headless',
        device_platform: 'linux',
      },
      await device.proof('/token')
    );
  const pending = await poll();
  const tooSoon = await poll();
  log('4 polls before approval', {
    first: ErrorSchema.parse(pending.body).error,
    immediate: ErrorSchema.parse(tooSoon.body).error,
  });
  check(ErrorSchema.parse(pending.body).error === 'authorization_pending', 'pending');
  check(ErrorSchema.parse(tooSoon.body).error === 'slow_down', 'slow_down');

  // A link with a wrong code only fills the page: nothing is looked up or counted. A POST from
  // another site is refused.
  await page.goto(new URL('/device?user_code=BBBB-BBBB', base).toString());
  const filled = await page.getByLabel('Code shown on your device').inputValue();
  const crossSite = await context.request.post(new URL('/device', base).toString(), {
    form: { user_code: 'BBBB-BBBB' },
    headers: { Origin: 'https://evil.example' },
    maxRedirects: 0,
  });
  const counted = await admin.query<{ failures: number }>(
    'SELECT failures FROM uts.account_user_code_failures WHERE account_id = $1',
    [ACCOUNT]
  );
  check(
    filled === 'BBBB-BBBB' && crossSite.status() === 403 && counted.rows.length === 0,
    'GET fills only, cross-site POST refused, nothing counted'
  );
  log('4 linked wrong code and cross-site POST', {
    filled,
    crossSiteStatus: crossSite.status(),
    wrongCodesCounted: counted.rows.length,
  });

  // The code from the link needs a passkey step-up, though the sign-in is recent.
  const approvalUrl = new URL(authorization.verification_uri_complete);
  await page.goto(new URL(`${approvalUrl.pathname}${approvalUrl.search}`, base).toString());
  await page.getByRole('button', { name: 'Continue' }).click();
  const linkedSource = await page.locator('#device-user-code').getAttribute('data-code-source');
  const approvalTitle = await page.title();
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByText('Device approved.', { exact: false }).waitFor({ timeout: 20_000 });
  const approved = await approval(authorization.device_code);
  check(
    linkedSource === 'link' && approved?.satisfied_by === '{passkey}',
    'linked code approved by passkey step-up'
  );
  log('4 linked code (step-up, tier B)', {
    page: approvalTitle,
    source: linkedSource,
    ...approved,
  });

  await sleep(10_500);
  const deviceTokensResponse = await poll();
  const deviceTokens = TokenSchema.parse(deviceTokensResponse.body);
  secrets.push(z.string().parse(deviceTokens.refresh_token), deviceTokens.access_token);
  const deviceClaims = decodeJwt(deviceTokens.access_token);
  check(deviceTokensResponse.status === 200, 'device token');
  log('4 device token', {
    status: deviceTokensResponse.status,
    refreshExpiresInDays: Math.round((deviceTokens.refresh_token_expires_in ?? 0) / DAY_SECONDS),
    amr: deviceClaims.amr,
    jti: deviceClaims.jti,
  });
  const retried = await poll();
  const retriedTokens = TokenSchema.parse(retried.body);
  secrets.push(z.string().parse(retriedTokens.refresh_token), retriedTokens.access_token);
  const thief = await dpop();
  const stolen = await post(
    '/token',
    {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: authorization.device_code,
      client_id: 'kilo-cli',
    },
    await thief.proof('/token')
  );
  const deviceGrant = await admin.query<{ status: string }>(
    'SELECT status FROM uts.refresh_grants WHERE id = $1',
    [z.string().parse(deviceClaims.sid)]
  );
  check(retried.status === 200 && stolen.status === 400, 'retry with the key, refusal without it');
  log('4 device code used again', {
    sameKeyRetry: retried.status,
    otherKey: { status: stolen.status, error: ErrorSchema.parse(stolen.body).error },
    grantAfterOtherKey: deviceGrant.rows[0]?.status,
  });

  // 5. A one-time ticket from the mobile grant.
  const issued = await post(
    '/tickets',
    {
      client_id: 'kilo-mobile',
      refresh_token: mobileGrant,
      purpose: 'stream',
      resource: 'urn:kilo:service:event-service',
      resource_id: 'session-e2e',
    },
    await mobile.proof('/tickets')
  );
  const ticket = z.object({ ticket: z.string(), expires_in: z.number() }).parse(issued.body);
  secrets.push(ticket.ticket);
  // The development redeemer `uts-ticket-test` may redeem for its listed audiences only.
  const redeem = async (audience: string) => {
    const response = await fetch(new URL('/__dev/tickets/redeem', base), {
      method: 'POST',
      body: JSON.stringify({ ticket: ticket.ticket, audience }),
      headers: { 'Content-Type': 'application/json' },
    });
    return {
      status: response.status,
      body: z.looseObject({ status: z.string() }).parse(await response.json()),
    };
  };
  const otherAudience = await redeem('session-ingest');
  const firstUse = await redeem('event-service');
  const secondUse = await redeem('event-service');
  check(otherAudience.body.status === 'refused', 'redeemer refused outside its audiences');
  check(firstUse.status === 200 && secondUse.body.status === 'invalid_ticket', 'ticket single use');
  log('5 ticket', {
    issued: issued.status,
    expiresIn: ticket.expires_in,
    audienceNotTheCallers: otherAudience.body,
    firstUse: { status: firstUse.status, body: firstUse.body },
    secondUse: { status: secondUse.status, body: secondUse.body },
  });

  // 6. The audit rows of the run.
  const audit = await admin.query<{ event_type: string; count: number }>(
    `SELECT event_type, count(*)::int AS count FROM uts.audit_events WHERE account_id = $1
     GROUP BY event_type ORDER BY min(id)`,
    [ACCOUNT]
  );
  const text = await admin.query<{ text: string }>(
    `SELECT string_agg(event::text, ' ') AS text FROM uts.audit_events WHERE account_id = $1`,
    [ACCOUNT]
  );
  const leaked = secrets.filter(value => text.rows[0].text.includes(value)).length;
  log('6 audit rows', { rows: audit.rows, credentialValuesInAudit: leaked });
  check(leaked === 0, 'no credential value in an audit row');

  await browser.close();
  await admin.end();
  console.log('e2e passed');
}

await main();
