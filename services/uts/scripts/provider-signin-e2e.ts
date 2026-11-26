/**
 * Local end-to-end run of the provider, SSO and email sign-in against
 * `wrangler dev -c wrangler.dev.jsonc`, the local identity store and three stand-in providers this
 * script serves on loopback ports: an
 * OpenID Connect provider (as Google, and as Apple with `form_post` and its ES256 client secret), a
 * GitHub-style OAuth provider, and a WorkOS-style SSO provider. The script acts as the browser: it
 * follows each redirect by hand and keeps the cookies.
 *
 * 1. Google, GitHub and WorkOS SSO each sign in on the CLI's authorization request, which then
 *    issues a code, and the code buys DPoP-bound tokens: sign-in -> code -> token.
 * 2. Apple posts its callback (`form_post`) from its own site.
 * 3. Email: five wrong codes lock the code but not its link; a new email's code signs in, and the
 *    link of another signs in after its confirmation page.
 * 4. Linking refusals: an address GitHub did not verify, SSO with the address of an existing
 *    account, a link without a tier A pass, an address of a domain that requires SSO; and a link
 *    with a tier A pass of the session, which succeeds.
 * 4b. Anonymous starts from one client address: the 11th in a minute is refused with 429.
 * 5. The audit rows of the run name no token, code, binder or address.
 *
 * Synthetic data only: every key and secret is generated for the run, written to a 0600
 * `.dev.vars.local` that `wrangler dev --env-file` reads and the run deletes, and never printed.
 *
 *   UTS_E2E_ADMIN_URL   admin login to the identity-store database (loopback only)
 *   UTS_E2E_APP_URL     app login to the same database, for the Worker's Hyperdrive binding
 *   UTS_E2E_PORT        first of the run's ports (default 9000): Worker, inspector, then the
 *                       three stand-in providers at +3, +4 and +5
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { UTS_ENDPOINTS } from '@kilocode/uts-contracts';
import {
  SignJWT,
  calculateJwkThumbprint,
  decodeJwt,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
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
  .parse(process.env.UTS_E2E_PORT ?? '9000');
const base = `http://127.0.0.1:${PORT}`;
const issuer = UTS_ENDPOINTS.development.issuer;
const OIDC = `http://127.0.0.1:${PORT + 3}`;
const GITHUB = `http://127.0.0.1:${PORT + 4}`;
const WORKOS = `http://127.0.0.1:${PORT + 5}`;
const CLI_REDIRECT = 'http://127.0.0.1:4100/callback';
const SCOPES = 'gateway:models.read kilo-chat:messages.read';
const SSO_DOMAIN = `e2e-${randomBytes(3).toString('hex')}.example.org`;
const SSO_CONNECTION = `conn_${randomBytes(6).toString('hex')}`;
const REQUIRED_DOMAIN = `required-${randomBytes(3).toString('hex')}.example.org`;

/** Every credential and address the run handles; none may appear in an audit row. */
const secrets: string[] = [];
const keep = <T extends string>(value: T): T => {
  secrets.push(value);
  return value;
};
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const b64 = (value: Buffer) => value.toString('base64url');

function log(step: string, detail: unknown) {
  console.log(`${step.padEnd(44)} ${JSON.stringify(detail)}`);
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`check failed: ${message}`);
}

// ---------------------------------------------------------------------------------------------
// The browser: a cookie jar for the Worker's origin, and redirects followed by hand. The Worker
// names its own origin as the issuer (http://localhost:8800); requests to it go to `base`.

const jar = new Map<string, string>();

/**
 * Every cookie the Worker sets is a `__Host-` cookie with `Max-Age` and no `Expires`, so the
 * joined `Set-Cookie` header splits safely before each `__Host-` name.
 */
function storeCookies(response: Response) {
  const joined = response.headers.get('Set-Cookie');
  for (const header of joined === null ? [] : joined.split(/,\s*(?=__Host-)/)) {
    const [pair, ...attributes] = header.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = attributes.some(attribute => attribute.trim().toLowerCase() === 'max-age=0');
    if (expired) jar.delete(name);
    else jar.set(name, keep(value));
  }
}

/** The URL a continue page (the answer to an SSO start form) navigates to. */
async function continueTarget(response: Response): Promise<string> {
  const html = await response.text();
  const target = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(html)?.[1];
  if (target === undefined) throw new Error(`no continue target (status ${response.status})`);
  return target.replaceAll('&amp;', '&');
}

function toWorker(url: string): URL {
  const target = new URL(url, base);
  if (target.origin === issuer) return new URL(`${target.pathname}${target.search}`, base);
  return target;
}

/**
 * The client address each request carries (`CF-Connecting-IP`, TEST-NET-3): a new one per request,
 * so the anonymous write limit sees one writer only where a step pins `pinnedAddress`.
 */
let pinnedAddress: string | null = null;
let addressCount = 0;

async function browse(url: string, init: RequestInit = {}): Promise<Response> {
  const target = toWorker(url);
  const headers = new Headers(init.headers);
  if (target.origin === base) {
    addressCount += 1;
    headers.set('CF-Connecting-IP', pinnedAddress ?? `203.0.113.${(addressCount % 250) + 1}`);
  }
  if (target.origin === base && jar.size > 0) {
    headers.set('Cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
  }
  const response = await fetch(target, { ...init, headers, redirect: 'manual' });
  if (target.origin === base) storeCookies(response);
  return response;
}

/** Follows redirects until a response is not one, or `stop` matches the next location. */
async function follow(url: string, stop: (location: URL) => boolean, init?: RequestInit) {
  let response = await browse(url, init);
  for (let hop = 0; hop < 10; hop += 1) {
    const location = response.headers.get('Location');
    if (response.status < 300 || response.status >= 400 || location === null) return { response };
    const next = new URL(location, toWorker(url));
    if (stop(next)) return { response, location: next };
    response = await browse(next.toString());
  }
  throw new Error('too many redirects');
}

function formPost(fields: Record<string, string>, origin = base): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: new URLSearchParams(fields).toString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Stand-in providers. Each authorization request takes the identity queued for it.

type Identity = { subject: string; email: string; verified: boolean };
const queued: Identity[] = [];
type Grant = {
  identity: Identity;
  redirectUri: string;
  challenge: string | null;
  nonce: string | null;
  clientId: string;
};
const grants = new Map<string, Grant>();
const tokenCalls: string[] = [];

async function readBody(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(z.instanceof(Buffer).parse(chunk));
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function authorize(url: URL, response: ServerResponse) {
  const identity = queued.shift();
  if (identity === undefined) return json(response, 500, { error: 'no identity queued' });
  const code = randomBytes(16).toString('hex');
  grants.set(code, {
    identity,
    redirectUri: url.searchParams.get('redirect_uri') ?? '',
    challenge: url.searchParams.get('code_challenge'),
    nonce: url.searchParams.get('nonce'),
    clientId: url.searchParams.get('client_id') ?? '',
  });
  const state = url.searchParams.get('state') ?? '';
  if (url.searchParams.get('response_mode') === 'form_post') {
    // Apple answers with a page that posts the code to the redirect URI; the run posts it.
    return json(response, 200, { action: url.searchParams.get('redirect_uri'), code, state });
  }
  const back = new URL(url.searchParams.get('redirect_uri') ?? '');
  back.searchParams.set('code', code);
  back.searchParams.set('state', state);
  response.writeHead(302, { Location: back.toString() });
  response.end();
}

/** The code's grant when the client, redirect URI and PKCE verifier match; null otherwise. */
function redeem(form: URLSearchParams, clientId: string): Grant | null {
  const grant = grants.get(form.get('code') ?? '');
  grants.delete(form.get('code') ?? '');
  if (grant === undefined || grant.clientId !== clientId) return null;
  if (form.get('redirect_uri') !== null && form.get('redirect_uri') !== grant.redirectUri)
    return null;
  if (grant.challenge !== null) {
    const verifier = form.get('code_verifier') ?? '';
    if (b64(sha256(verifier)) !== grant.challenge) return null;
  }
  return grant;
}

async function main() {
  const idp = await generateKeyPair('RS256', { extractable: true });
  const idpJwk = { ...(await exportJWK(idp.publicKey)), kid: 'e2e-idp', alg: 'RS256', use: 'sig' };
  const apple = await generateKeyPair('ES256', { extractable: true });
  const settings = {
    googleSecret: keep(randomBytes(24).toString('base64url')),
    githubSecret: keep(randomBytes(24).toString('base64url')),
    workosKey: keep(`sk_test_${randomBytes(24).toString('hex')}`),
    hashKey: keep(randomBytes(32).toString('base64url')),
  };

  const oidcServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', OIDC);
    if (url.pathname === '/authorize') return authorize(url, response);
    if (url.pathname === '/jwks') return json(response, 200, { keys: [idpJwk] });
    if (url.pathname !== '/token' || request.method !== 'POST') return json(response, 404, {});
    const form = await readBody(request);
    const clientId = form.get('client_id') ?? '';
    tokenCalls.push(clientId);
    if (clientId === 'e2e-apple') {
      // Sign in with Apple: the client secret is an ES256 JWT of the team, for the services id.
      try {
        await jwtVerify(form.get('client_secret') ?? '', apple.publicKey, {
          issuer: 'E2ETEAM',
          subject: 'e2e-apple',
          audience: 'https://appleid.apple.com',
          maxTokenAge: '6m',
        });
      } catch {
        return json(response, 401, { error: 'invalid_client' });
      }
    } else if (form.get('client_secret') !== settings.googleSecret) {
      return json(response, 401, { error: 'invalid_client' });
    }
    const grant = redeem(form, clientId);
    if (grant === null) return json(response, 400, { error: 'invalid_grant' });
    const idToken = await new SignJWT({
      nonce: grant.nonce,
      email: grant.identity.email,
      email_verified:
        clientId === 'e2e-apple' ? String(grant.identity.verified) : grant.identity.verified,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'e2e-idp' })
      .setIssuer(OIDC)
      .setSubject(grant.identity.subject)
      .setAudience(clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(idp.privateKey);
    json(response, 200, { access_token: randomBytes(16).toString('hex'), id_token: idToken });
  });

  const githubTokens = new Map<string, Identity>();
  const githubServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', GITHUB);
    if (url.pathname === '/login/oauth/authorize') return authorize(url, response);
    if (url.pathname === '/login/oauth/access_token') {
      const form = await readBody(request);
      if (form.get('client_secret') !== settings.githubSecret) {
        return json(response, 200, { error: 'incorrect_client_credentials' });
      }
      const grant = redeem(form, form.get('client_id') ?? '');
      if (grant === null) return json(response, 200, { error: 'bad_verification_code' });
      const accessToken = randomBytes(16).toString('hex');
      githubTokens.set(accessToken, grant.identity);
      return json(response, 200, { access_token: accessToken, token_type: 'bearer' });
    }
    const identity = githubTokens.get((request.headers.authorization ?? '').replace('Bearer ', ''));
    if (identity === undefined || request.headers['user-agent'] === undefined) {
      return json(response, 401, { message: 'Bad credentials' });
    }
    if (url.pathname === '/api/user') return json(response, 200, { id: Number(identity.subject) });
    if (url.pathname === '/api/user/emails') {
      return json(response, 200, [
        { email: identity.email, verified: identity.verified, primary: true },
      ]);
    }
    json(response, 404, {});
  });

  const workosServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', WORKOS);
    if (url.pathname === '/sso/authorize') {
      if (url.searchParams.get('connection') !== SSO_CONNECTION) {
        return json(response, 400, { error: 'unknown connection' });
      }
      return authorize(url, response);
    }
    if (url.pathname !== '/sso/token') return json(response, 404, {});
    const form = await readBody(request);
    if (form.get('client_secret') !== settings.workosKey) return json(response, 401, {});
    const grant = redeem(form, form.get('client_id') ?? '');
    if (grant === null) return json(response, 400, { error: 'invalid_grant' });
    json(response, 200, {
      access_token: randomBytes(16).toString('hex'),
      profile: {
        id: grant.identity.subject,
        connection_id: SSO_CONNECTION,
        organization_id: 'org_e2e',
        email: grant.identity.email,
      },
    });
  });

  for (const [server, port] of [
    [oidcServer, PORT + 3],
    [githubServer, PORT + 4],
    [workosServer, PORT + 5],
  ] as const) {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(port, '127.0.0.1', resolve);
    await promise;
  }

  const vars = {
    SIGNIN_GOOGLE_CLIENT_ID: 'e2e-google',
    SIGNIN_GOOGLE_CLIENT_SECRET: settings.googleSecret,
    SIGNIN_APPLE_CLIENT_ID: 'e2e-apple',
    SIGNIN_APPLE_TEAM_ID: 'E2ETEAM',
    SIGNIN_APPLE_KEY_ID: 'E2EKEY',
    SIGNIN_APPLE_PRIVATE_KEY: (await exportPKCS8(apple.privateKey)).replaceAll('\n', '\\n'),
    SIGNIN_GITHUB_CLIENT_ID: 'e2e-github',
    SIGNIN_GITHUB_CLIENT_SECRET: settings.githubSecret,
    SIGNIN_WORKOS_CLIENT_ID: 'client_e2e',
    SIGNIN_WORKOS_API_KEY: settings.workosKey,
    SIGNIN_EMAIL_HASH_KEY: settings.hashKey,
    SIGNIN_DEV_ENDPOINTS: JSON.stringify({
      oidc: Object.fromEntries(
        ['google', 'apple'].map(provider => [
          provider,
          {
            issuers: [OIDC],
            authorization: `${OIDC}/authorize`,
            token: `${OIDC}/token`,
            jwks: `${OIDC}/jwks`,
          },
        ])
      ),
      github: {
        authorization: `${GITHUB}/login/oauth/authorize`,
        token: `${GITHUB}/login/oauth/access_token`,
        api: `${GITHUB}/api`,
      },
      workos: { authorization: `${WORKOS}/sso/authorize`, token: `${WORKOS}/sso/token` },
    }),
  };
  writeFileSync(
    '.dev.vars.local',
    Object.entries(vars)
      .map(([name, value]) => `${name}='${value}'`)
      .join('\n'),
    { mode: 0o600 }
  );

  const worker: ChildProcess = spawn(
    './node_modules/.bin/wrangler',
    [
      'dev',
      '-c',
      'wrangler.dev.jsonc',
      '--env-file',
      '.dev.vars.local',
      '--port',
      String(PORT),
      '--inspector-port',
      String(PORT + 1),
      '--persist-to',
      `/tmp/uts-signin-e2e-${PORT}`,
      '--var',
      `WEBAUTHN_ORIGINS:http://localhost:${PORT}`,
    ],
    {
      env: { ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE: appUrl },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    for (let attempt = 0; ; attempt += 1) {
      const ready = await fetch(`${base}/.well-known/oauth-authorization-server`).catch(() => null);
      if (ready?.ok) break;
      if (attempt > 90) throw new Error('wrangler dev did not start');
      await sleep(1000);
    }
    await admin.connect();
    await admin.query('SET ROLE uts_owner');
    await run(admin);
  } finally {
    worker.kill('SIGTERM');
    rmSync('.dev.vars.local', { force: true });
    for (const server of [oidcServer, githubServer, workosServer]) server.close();
    await admin.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------

async function dpop() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
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
        .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk })
        .sign(privateKey),
  };
}

const TokenSchema = z.looseObject({
  access_token: z.string(),
  refresh_token: z.string(),
  issued_tokens: z.array(z.object({ access_token: z.string(), audience: z.string() })),
});

/** A CLI authorization request on the sign-in pages: its URL, PKCE verifier and DPoP key. */
type CliAuthorization = {
  url: string;
  verifier: string;
  key: { jkt: string; proof: () => Promise<string> };
};

async function cliAuthorization(): Promise<CliAuthorization> {
  const verifier = keep(randomBytes(32).toString('base64url'));
  const key = await dpop();
  const url = new URL('/authorize', issuer);
  for (const [name, value] of Object.entries({
    client_id: 'kilo-cli',
    redirect_uri: CLI_REDIRECT,
    response_type: 'code',
    scope: SCOPES,
    code_challenge: b64(sha256(verifier)),
    code_challenge_method: 'S256',
    dpop_jkt: key.jkt,
    state: randomUUID(),
    dev_handoff: 'signin',
  })) {
    url.searchParams.set(name, value);
  }
  return { url: url.toString(), verifier, key };
}

/** The code the authorization request ends in, once the browser holds a session. */
async function codeOf(authorizeUrl: string): Promise<string> {
  const response = await browse(authorizeUrl);
  const location = new URL(response.headers.get('Location') ?? '');
  check(
    response.status === 302 && location.origin + location.pathname === CLI_REDIRECT,
    'code redirect'
  );
  check(location.searchParams.get('iss') === issuer, 'iss in the authorization response');
  return keep(location.searchParams.get('code') ?? '');
}

/** Exchanges the code for DPoP-bound tokens and returns the access token's claims. */
async function tokensOf(code: string, cli: CliAuthorization) {
  const response = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { DPoP: await cli.key.proof() },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLI_REDIRECT,
      client_id: 'kilo-cli',
      code_verifier: cli.verifier,
    }),
  });
  check(response.status === 200, `token status ${response.status}`);
  const tokens = TokenSchema.parse(await response.json());
  keep(tokens.refresh_token);
  for (const issued of tokens.issued_tokens) keep(issued.access_token);
  return { claims: decodeJwt(tokens.access_token), count: tokens.issued_tokens.length };
}

/** The sign-in page link of a provider on the authorization request's page. */
async function providerLink(authorizeUrl: string, provider: string): Promise<string> {
  const page = await browse(authorizeUrl);
  const html = await page.text();
  const match = new RegExp(`href="(/signin/oauth/${provider}/start\\?[^"]+)"`).exec(html);
  check(page.status === 200 && match !== null, `sign-in page lists ${provider}`);
  return (match?.[1] ?? '').replaceAll('&amp;', '&');
}

/** Signs in through a redirect provider and returns the response of the Worker's callback. */
async function providerSignIn(startUrl: string): Promise<Response> {
  const { location } = await follow(startUrl, next => next.pathname.endsWith('/callback'));
  check(location !== undefined, 'provider redirected back');
  return await browse(location?.toString() ?? '');
}

async function sessionOf(accountEmail: string) {
  const result = await adminClient.query<{ account_id: string; session_id: string; amr: string[] }>(
    `SELECT session.account_id, session.id AS session_id, session.amr::text[] AS amr
     FROM uts.browser_sessions AS session JOIN uts.accounts AS account ON account.id = session.account_id
     WHERE account.primary_email = $1 ORDER BY session.created_at DESC LIMIT 1`,
    [accountEmail]
  );
  return result.rows[0];
}

let adminClient: pg.Client;

async function run(admin: pg.Client) {
  adminClient = admin;
  const existingEmail = keep(`existing-${randomBytes(3).toString('hex')}@example.com`);
  const existingAccount = `e2e:${randomUUID()}`;
  const orgId = randomUUID();
  const requiredOrg = randomUUID();
  await admin.query('INSERT INTO uts.accounts (id, primary_email) VALUES ($1, $2)', [
    existingAccount,
    existingEmail,
  ]);
  await admin.query(
    'INSERT INTO uts.sso_connections (org_id, workos_connection_id) VALUES ($1, $2)',
    [orgId, SSO_CONNECTION]
  );
  for (const [org, domain, enforcement] of [
    [orgId, SSO_DOMAIN, 'optional'],
    [requiredOrg, REQUIRED_DOMAIN, 'required'],
  ]) {
    await admin.query(
      `INSERT INTO uts.sso_domains (org_id, domain, status, dns_challenge_hash, verified_at)
       VALUES ($1, $2, 'verified', $3, now())`,
      [org, domain, randomBytes(32)]
    );
    await admin.query(
      'INSERT INTO uts.org_sso_policies (org_id, enforcement, event_version) VALUES ($1, $2, 1)',
      [org, enforcement]
    );
  }

  // 1a. Google: sign-in -> code -> token.
  const googleEmail = keep(`person-${randomBytes(3).toString('hex')}@gmail.com`);
  {
    jar.clear();
    const cli = await cliAuthorization();
    queued.push({ subject: `g-${randomUUID()}`, email: googleEmail, verified: true });
    const callback = await providerSignIn(await providerLink(cli.url, 'google'));
    check(callback.status === 303, `google callback ${callback.status}`);
    check(jar.has('__Host-uts_session'), 'session cookie');
    check(
      ![...jar.keys()].some(name => name.startsWith('__Host-uts_flow_')),
      'flow cookie cleared'
    );
    const tokens = await tokensOf(await codeOf(cli.url), cli);
    const session = await sessionOf(googleEmail);
    check(tokens.claims.sub === session.account_id, 'token subject is the signed-in account');
    log('1a google sign-in -> code -> token', {
      callback: callback.status,
      account: session.account_id,
      amr: session.amr,
      tokens: tokens.count,
      sub: tokens.claims.sub === session.account_id ? 'session account' : 'other',
      aud: tokens.claims.aud,
    });
  }

  // 1b. GitHub (OAuth 2, no OpenID Connect): sign-in -> code -> token.
  const githubEmail = keep(`coder-${randomBytes(3).toString('hex')}@example.com`);
  {
    jar.clear();
    const cli = await cliAuthorization();
    queued.push({
      subject: String(randomBytes(3).readUIntBE(0, 3)),
      email: githubEmail,
      verified: true,
    });
    const callback = await providerSignIn(await providerLink(cli.url, 'github'));
    check(callback.status === 303, `github callback ${callback.status}`);
    const tokens = await tokensOf(await codeOf(cli.url), cli);
    const session = await sessionOf(githubEmail);
    check(tokens.claims.sub === session.account_id, 'github token subject');
    log('1b github sign-in -> code -> token', {
      callback: callback.status,
      amr: session.amr,
      tokens: tokens.count,
    });
  }

  // 1c. WorkOS SSO: the address picks the connection; sign-in -> code -> token.
  const ssoEmail = keep(`member-${randomBytes(3).toString('hex')}@${SSO_DOMAIN}`);
  {
    jar.clear();
    const cli = await cliAuthorization();
    const page = await (await browse(cli.url)).text();
    const returnTo =
      /name="return_to" value="([^"]+)"/.exec(page)?.[1]?.replaceAll('&amp;', '&') ?? '';
    check(page.includes('Sign in with SSO'), 'sign-in page offers SSO');
    queued.push({
      subject: `prof_${randomBytes(6).toString('hex')}`,
      email: ssoEmail,
      verified: false,
    });
    const start = await browse(
      '/signin/sso/start',
      formPost({ email: ssoEmail, return_to: returnTo })
    );
    check(start.status === 200 && start.headers.get('Location') === null, 'SSO start is a page');
    const toWorkos = new URL(await continueTarget(start));
    check(
      toWorkos.searchParams.get('connection') === SSO_CONNECTION,
      'SSO start names the connection'
    );
    const callback = await providerSignIn(toWorkos.toString());
    check(callback.status === 303, `sso callback ${callback.status}`);
    const tokens = await tokensOf(await codeOf(cli.url), cli);
    const session = await sessionOf(ssoEmail);
    check(
      session.amr[0] === 'sso' && tokens.claims.sub === session.account_id,
      'sso session and token'
    );
    log('1c workos sso sign-in -> code -> token', {
      connection: 'flow connection',
      amr: session.amr,
      tokenAmr: tokens.claims.amr,
      tokens: tokens.count,
    });
  }

  // 2. Apple: the callback is a cross-site form post, and the client secret is an ES256 JWT.
  {
    jar.clear();
    const appleEmail = keep(`relay-${randomBytes(3).toString('hex')}@privaterelay.appleid.com`);
    queued.push({ subject: `a-${randomUUID()}`, email: appleEmail, verified: true });
    const start = await browse('/signin/oauth/apple/start');
    const authorizeAt = new URL(start.headers.get('Location') ?? '');
    check(authorizeAt.searchParams.get('response_mode') === 'form_post', 'apple form_post');
    check(!authorizeAt.searchParams.has('code_challenge'), 'apple without PKCE');
    const page = z
      .object({ action: z.string(), code: z.string(), state: z.string() })
      .parse(await (await fetch(authorizeAt)).json());
    const callback = await browse(
      page.action,
      formPost({ code: page.code, state: page.state }, 'https://appleid.apple.com')
    );
    check(
      callback.status === 303 && callback.headers.get('Location') === '/signin/done',
      'apple signed in'
    );
    const session = await sessionOf(appleEmail);
    log('2 apple form_post sign-in', {
      callback: callback.status,
      amr: session.amr,
      clientSecret: 'ES256 verified by stand-in',
    });
  }

  // 3. Email: five wrong codes lock the code but not its link; then a code and a link sign in.
  {
    jar.clear();
    const email = keep(`mail-${randomBytes(3).toString('hex')}@example.com`);
    const mail = async () => {
      const response = await fetch(`${base}/__dev/mail?to=${encodeURIComponent(email)}`);
      const message = z
        .object({ link: z.string(), code: z.string().nullable() })
        .parse(await response.json());
      keep(message.link);
      if (message.code !== null) keep(message.code);
      return message;
    };
    const sent = await browse(
      '/signin/email/start',
      formPost({ email, return_to: '/signin/done' })
    );
    check(sent.status === 200, `email start ${sent.status}`);
    const first = await mail();
    const wrong = first.code === '000000' ? '111111' : '000000';
    const statuses = [];
    for (let entry = 0; entry < 5; entry += 1) {
      const response = await browse('/signin/email/code', formPost({ email, code: wrong }));
      statuses.push(response.status);
    }
    const right = await browse('/signin/email/code', formPost({ email, code: first.code ?? '' }));
    const stored = await admin.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM uts.email_codes WHERE email = $1',
      [email]
    );
    check(statuses.join() === '400,400,400,400,403', `wrong entries ${statuses.join()}`);
    check(right.status === 400, 'the right code is refused once the code is locked');
    check(!jar.has('__Host-uts_session'), 'no session after the lock');
    // Wrong entries by someone else do not lock the owner out: the email's link still works.
    const linkPage = await browse(first.link);
    const token = new URL(first.link).searchParams.get('token') ?? '';
    const lockedCodeLink = await browse('/signin/email/link', formPost({ token }));
    check(lockedCodeLink.status === 303 && jar.has('__Host-uts_session'), 'link after the lock');
    log('3a email code wrong 5 times locks', {
      wrongEntries: statuses,
      rightCodeAfter: right.status,
      row: stored.rows[0],
      linkPage: linkPage.status,
      linkOfLockedCode: lockedCodeLink.status,
    });
    jar.clear();

    const cli = await cliAuthorization();
    await browse(
      '/signin/email/start',
      formPost({ email, return_to: new URL(cli.url).pathname + new URL(cli.url).search })
    );
    const second = await mail();
    const signedIn = await browse(
      '/signin/email/code',
      formPost({ email, code: second.code ?? '' })
    );
    check(signedIn.status === 303 && jar.has('__Host-uts_session'), 'email code signs in');
    const tokens = await tokensOf(await codeOf(cli.url), cli);
    const session = await sessionOf(email);
    check(tokens.claims.sub === session.account_id, 'email token subject');

    jar.clear();
    await browse('/signin/email/start', formPost({ email }));
    const third = await mail();
    const confirm = await browse(third.link);
    const linkToken = new URL(third.link).searchParams.get('token') ?? '';
    const confirmText = await confirm.text();
    check(confirmText.includes(`Sign in as ${email.slice(0, 1)}…@`), 'link page names the address');
    // The same link opened in another browser (no binder cookie) needs a second confirmation.
    const binders = [...jar.entries()];
    jar.clear();
    const otherPage = await (await browse(third.link)).text();
    const otherUnconfirmed = await browse('/signin/email/link', formPost({ token: linkToken }));
    check(
      otherPage.includes('another browser') && otherUnconfirmed.status === 409,
      'another browser must confirm'
    );
    for (const [name, value] of binders) jar.set(name, value);
    const viaLink = await browse('/signin/email/link', formPost({ token: linkToken }));
    const reuse = await browse('/signin/email/link', formPost({ token: linkToken }));
    check(
      confirm.status === 200 && viaLink.status === 303 && reuse.status === 400,
      'email link once'
    );
    const foreign = await browse(
      '/signin/email/code',
      formPost({ email, code: '123456' }, 'https://evil.example')
    );
    check(foreign.status === 403, 'code posted from another site refused');
    log('3b email code and link sign in', {
      code: signedIn.status,
      tokens: tokens.count,
      linkConfirmPage: confirm.status,
      otherBrowserUnconfirmed: otherUnconfirmed.status,
      link: viaLink.status,
      linkReuse: reuse.status,
      foreignOrigin: foreign.status,
    });
  }

  // 4. Linking refusals, and a link with a tier A pass of the session.
  {
    jar.clear();
    queued.push({
      subject: String(randomBytes(3).readUIntBE(0, 3)),
      email: existingEmail,
      verified: false,
    });
    const unverified = await providerSignIn('/signin/oauth/github/start');
    queued.push({
      subject: String(randomBytes(3).readUIntBE(0, 3)),
      email: existingEmail,
      verified: true,
    });
    const verified = await providerSignIn('/signin/oauth/github/start');
    check(
      unverified.status === 409 && verified.status === 303,
      'unverified refused, verified links'
    );

    jar.clear();
    const ssoExisting = keep(`existing@${SSO_DOMAIN}`);
    await admin.query('INSERT INTO uts.accounts (id, primary_email) VALUES ($1, $2)', [
      `e2e:${randomUUID()}`,
      ssoExisting,
    ]);
    queued.push({
      subject: `prof_${randomBytes(6).toString('hex')}`,
      email: ssoExisting,
      verified: false,
    });
    const ssoStart = await browse('/signin/sso/start', formPost({ email: ssoExisting }));
    const ssoRefused = await providerSignIn(await continueTarget(ssoStart));

    jar.clear();
    queued.push({
      subject: `g-${randomUUID()}`,
      email: keep(`x@${REQUIRED_DOMAIN}`),
      verified: true,
    });
    const requiresSso = await providerSignIn('/signin/oauth/google/start');

    // Signed in by Google (step 1a), the session links GitHub only with a tier A pass.
    jar.clear();
    queued.push({
      subject: `g-${randomUUID()}`,
      email: keep(`linker-${randomBytes(3).toString('hex')}@gmail.com`),
      verified: true,
    });
    await providerSignIn('/signin/oauth/google/start');
    const linker = await adminClient.query<{ account_id: string; id: string }>(
      `SELECT account_id, id FROM uts.browser_sessions ORDER BY created_at DESC LIMIT 1`
    );
    const noPass = await browse(`/signin/oauth/github/start?intent=link&gate_pass=${randomUUID()}`);
    const pass = await admin.query<{ id: string }>(
      `INSERT INTO uts.gate_passes (account_id, browser_session_id, tier, action, satisfied_by, expires_at)
       VALUES ($1, $2, 'a', 'method_add', '{recent_sign_in,email_code}', now() + interval '10 minutes')
       RETURNING id`,
      [linker.rows[0].account_id, linker.rows[0].id]
    );
    queued.push({
      subject: String(randomBytes(3).readUIntBE(0, 3)),
      email: keep(`other-${randomBytes(3).toString('hex')}@example.com`),
      verified: false,
    });
    const linked = await providerSignIn(
      `/signin/oauth/github/start?intent=link&gate_pass=${pass.rows[0].id}`
    );
    const methods = await admin.query<{ provider: string; gate_pass_id: string | null }>(
      'SELECT provider, gate_pass_id FROM uts.sign_in_methods WHERE account_id = $1 ORDER BY added_at',
      [linker.rows[0].account_id]
    );
    check(ssoRefused.status === 409, `sso by email refused ${ssoRefused.status}`);
    check(requiresSso.status === 403, `sso-required domain refused ${requiresSso.status}`);
    check(noPass.status === 403, `link without pass ${noPass.status}`);
    check(linked.status === 303 && methods.rows.length === 2, 'link with pass');
    const existingMethods = await admin.query<{ provider: string }>(
      'SELECT provider FROM uts.sign_in_methods WHERE account_id = $1',
      [existingAccount]
    );
    log('4 linking', {
      githubUnverifiedEmailOfExistingAccount: unverified.status,
      githubVerifiedEmailOfExistingAccount: `${verified.status} (linked: ${existingMethods.rows.map(row => row.provider).join()})`,
      ssoEmailOfExistingAccount: ssoRefused.status,
      googleAddressInSsoRequiredDomain: requiresSso.status,
      linkWithoutTierAPass: noPass.status,
      linkWithTierAPass: `${linked.status} (methods: ${methods.rows.map(row => `${row.provider}${row.gate_pass_id === null ? '' : '+pass'}`).join()})`,
    });
  }

  // 4b. Anonymous starts from one client address: 10 a minute per isolate, then 429.
  {
    jar.clear();
    pinnedAddress = '198.51.100.7';
    const statuses: number[] = [];
    for (let start = 0; start < 11; start += 1) {
      const response = await browse('/signin/oauth/google/start');
      statuses.push(response.status);
    }
    const emailStart = await browse(
      '/signin/email/start',
      formPost({ email: keep(`flood-${randomBytes(3).toString('hex')}@example.com`) })
    );
    const emailPage = await emailStart.text();
    // SSO starts have their own allowance, so an office behind this address still reaches SSO.
    const ssoStart = await browse(
      '/signin/sso/start',
      formPost({ email: keep(`office-${randomBytes(3).toString('hex')}@${SSO_DOMAIN}`) })
    );
    pinnedAddress = null;
    const other = await browse('/signin/oauth/google/start');
    check(
      statuses.slice(0, 10).every(status => status === 302 || status === 303) &&
        statuses[10] === 429 &&
        emailStart.status === 429 &&
        emailStart.headers.get('Retry-After') !== null &&
        emailPage.includes('Too many sign-in attempts') &&
        ssoStart.status === 200 &&
        other.status !== 429,
      `anonymous start limit ${statuses.join()} email ${emailStart.status} sso ${ssoStart.status} other ${other.status}`
    );
    log('4b anonymous start limit', {
      sameAddress: statuses,
      emailStartSameAddress: `${emailStart.status} (page, Retry-After ${emailStart.headers.get('Retry-After')})`,
      ssoStartSameAddress: ssoStart.status,
      otherAddress: other.status,
    });
    jar.clear();
  }

  // 5. The audit rows of the run.
  const rows = await admin.query<{ event_type: string; outcome: string; text: string }>(
    `SELECT event_type, event #>> '{data,outcome}' AS outcome, event::text AS text FROM uts.audit_events ORDER BY id`
  );
  const counts: Record<string, number> = {};
  for (const row of rows.rows) {
    const key = `${row.event_type} ${row.outcome}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const leaked = secrets.filter(
    value => value.length >= 6 && rows.rows.some(row => row.text.includes(value))
  );
  check(leaked.length === 0, `${leaked.length} secret or address values in audit rows`);
  log('5 audit rows (type outcome: count)', counts);
  log('5 values checked against audit rows', { values: secrets.length, found: leaked.length });
  log('stand-in token endpoint calls', { count: tokenCalls.length });

  // Timing of the GitHub callback (identity calls to the stand-in plus the one statement).
  const durations: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    jar.clear();
    queued.push({
      subject: String(1_000_000 + index),
      email: keep(`t${index}-${randomBytes(2).toString('hex')}@example.com`),
      verified: true,
    });
    const start = await browse('/signin/oauth/github/start');
    const { location } = await follow(start.headers.get('Location') ?? '', next =>
      next.pathname.endsWith('/callback')
    );
    const began = performance.now();
    const callback = await browse(location?.toString() ?? '');
    durations.push(performance.now() - began);
    check(callback.status === 303, 'timed callback');
  }
  durations.sort((left, right) => left - right);
  log('callback timing (ms, 20 sign-ins)', {
    p50: Number(durations[9].toFixed(1)),
    p95: Number(durations[18].toFixed(1)),
  });
  console.log('provider sign-in e2e: all checks passed');
}

await main();
