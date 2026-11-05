/**
 * Local stand-in for the Claude Platform OAuth surface, for development and
 * end-to-end checks without an Anthropic account.
 *
 * It serves the OIDC discovery document, the JWKS, an approval page, and the
 * token endpoint. Like auth.claude.com it accepts only a client assertion that
 * Kilo's federation key signed for the app's audience, a single-use `jti`, an
 * exact redirect URI, and a matching PKCE verifier, so the stub exercises the
 * real signing and verification paths.
 *
 * Usage: `pnpm dev:mock-anthropic` with the same environment as the web app.
 * Point `CLAUDE_OIDC_ISSUER` at `<url>/users` and `CLAUDE_AUTH_BASE_URL` at
 * `<url>`. `GET /test/requests` lists the requests the stub received.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createBillingStub } from './billing';

const PORT = Number(process.env.MOCK_ANTHROPIC_PORT ?? 4791);
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;
const ISSUER = `${BASE_URL}/users`;
const CODE_LIFETIME_MS = 5 * 60 * 1000;
const ID_TOKEN_LIFETIME_S = 600;

// The key that signs ID tokens. It changes on every start, like a rotation.
const idTokenKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ID_TOKEN_KID = `mock-${randomBytes(4).toString('hex')}`;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the mock Anthropic server`);
  return value;
}

// Kilo's federation public key, derived from the same key the web app signs with.
const federationPublicKey = createPublicKey(
  createPrivateKey(requireEnv('CLAUDE_FEDERATION_PRIVATE_KEY').replace(/\\n/g, '\n'))
);
const federationIssuer = requireEnv('CLAUDE_FEDERATION_ISSUER');
const billingClientId = process.env.CLAUDE_BILLING_CLIENT_ID;

/** Each OAuth app's client ID and the assertion audience its settings expect. */
const clientAudiences = new Map<string, string>([
  [requireEnv('CLAUDE_SIGN_IN_CLIENT_ID'), requireEnv('CLAUDE_SIGN_IN_ASSERTION_AUDIENCE')],
]);
if (billingClientId)
  clientAudiences.set(billingClientId, requireEnv('CLAUDE_BILLING_ASSERTION_AUDIENCE'));
if (process.env.CLAUDE_OPERATOR_TOKEN_AUDIENCE)
  clientAudiences.set('operator', requireEnv('CLAUDE_OPERATOR_TOKEN_AUDIENCE'));

type IssuedCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  nonce: string | null;
  email: string;
  emailVerified: boolean;
  expiresAt: number;
};

const codes = new Map<string, IssuedCode>();
const usedJtis = new Map<string, number>();
const recordedRequests: Array<{ method: string; path: string; body: unknown; at: string }> = [];

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: ID_TOKEN_KID }));
  const body = base64url(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(`${header}.${body}`), {
    key: idTokenKeys.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${body}.${base64url(signature)}`;
}

type JwtClaims = Record<string, unknown>;

function verifyJwt(token: string, key: KeyObject): JwtClaims | null {
  const [header, body, signature] = token.split('.');
  if (!header || !body || !signature) return null;
  const valid = verify(
    'sha256',
    Buffer.from(`${header}.${body}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url')
  );
  if (!valid) return null;
  const claims: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return typeof claims === 'object' && claims !== null
    ? Object.fromEntries(Object.entries(claims))
    : null;
}

/** Applies auth.claude.com's client assertion rules; returns the failure reason or null. */
function checkClientAssertion(clientId: string, assertion: unknown): string | null {
  const audience = clientAudiences.get(clientId);
  if (!audience) return 'unknown client_id';
  if (typeof assertion !== 'string') return 'missing client_assertion';
  const claims = verifyJwt(assertion, federationPublicKey);
  if (!claims) return 'bad assertion signature';
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== federationIssuer) return 'assertion iss mismatch';
  if (claims.aud !== audience) return 'assertion aud must be exactly one matching audience';
  if (typeof claims.exp !== 'number' || claims.exp <= now) return 'assertion expired';
  if (typeof claims.iat !== 'number' || claims.exp - claims.iat > 3600) {
    return 'assertion lifetime exceeds one hour';
  }
  if (typeof claims.jti !== 'string') return 'assertion has no jti';
  if (usedJtis.has(claims.jti)) return 'assertion jti reused';
  usedJtis.set(claims.jti, claims.exp);
  return null;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location });
  response.end();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

/** The approval page: a person picks the email the ID token carries, then approves or declines. */
function approvalPage(params: URLSearchParams): string {
  const hidden = [...params.entries()]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`
    )
    .join('');
  return `<!doctype html><html><body><h1>Mock Claude approval</h1>
<form method="post" action="/oauth/authorize/decision">${hidden}
<label>Email <input name="mock_email" value="ada@example.com"></label>
<label><input type="checkbox" name="mock_email_verified" checked> Email verified</label>
<button name="decision" value="approve">Approve</button>
<button name="decision" value="decline">Decline</button>
</form></body></html>`;
}

function handleAuthorize(url: URL, response: ServerResponse): void {
  const params = url.searchParams;
  if (params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256') {
    response.writeHead(400, { 'content-type': 'text/plain' });
    response.end('invalid authorization request');
    return;
  }
  const clientId = params.get('client_id') ?? '';
  if (!clientAudiences.has(clientId) || !params.get('redirect_uri') || !params.get('state')) {
    response.writeHead(400, { 'content-type': 'text/plain' });
    response.end('unknown client or missing parameter');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(approvalPage(params));
}

function handleDecision(form: URLSearchParams, response: ServerResponse): void {
  const redirectUri = form.get('redirect_uri') ?? '';
  const state = form.get('state') ?? '';
  const target = new URL(redirectUri);
  target.searchParams.set('state', state);
  if (form.get('decision') !== 'approve') {
    target.searchParams.set('error', 'access_denied');
    redirect(response, target.toString());
    return;
  }
  const code = base64url(randomBytes(24));
  codes.set(code, {
    clientId: form.get('client_id') ?? '',
    redirectUri,
    codeChallenge: form.get('code_challenge') ?? '',
    scope: form.get('scope') ?? '',
    nonce: form.get('nonce'),
    email: form.get('mock_email') ?? 'ada@example.com',
    emailVerified: form.get('mock_email_verified') === 'on',
    expiresAt: Date.now() + CODE_LIFETIME_MS,
  });
  target.searchParams.set('code', code);
  redirect(response, target.toString());
}

function handleToken(body: Record<string, unknown>, response: ServerResponse): void {
  const clientId = typeof body.client_id === 'string' ? body.client_id : '';
  const assertionFailure = checkClientAssertion(clientId, body.client_assertion);
  if (assertionFailure) {
    send(response, 401, { error: 'invalid_client', error_description: assertionFailure });
    return;
  }
  if (body.grant_type !== 'authorization_code' || typeof body.code !== 'string') {
    send(response, 400, { error: 'invalid_request' });
    return;
  }
  const issued = codes.get(body.code);
  codes.delete(body.code);
  const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  if (
    !issued ||
    issued.expiresAt < Date.now() ||
    issued.clientId !== clientId ||
    issued.redirectUri !== body.redirect_uri ||
    issued.codeChallenge !== challenge
  ) {
    send(response, 400, { error: 'invalid_grant' });
    return;
  }

  const scopes = new Set(issued.scope.split(' '));
  const now = Math.floor(Date.now() / 1000);
  const idToken = signJwt({
    iss: ISSUER,
    // Pairwise: the same person gets a different subject in every app.
    sub: base64url(createHash('sha256').update(`${clientId}:${issued.email}`).digest()),
    aud: clientId,
    iat: now,
    exp: now + ID_TOKEN_LIFETIME_S,
    auth_time: now,
    ...(issued.nonce ? { nonce: issued.nonce } : {}),
    ...(scopes.has('email') ? { email: issued.email } : {}),
    ...(scopes.has('email') && issued.emailVerified ? { email_verified: true } : {}),
    ...(scopes.has('profile') ? { name: issued.email.split('@')[0] } : {}),
  });
  send(response, 200, {
    access_token: `mock-at-${randomUUID()}`,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: issued.scope,
    id_token: idToken,
  });
}

const handleBilling = createBillingStub(checkClientAssertion);

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  const now = Date.now();
  for (const [code, issued] of codes) {
    if (issued.expiresAt <= now) codes.delete(code);
  }
  for (const [jti, expiresAt] of usedJtis) {
    if (expiresAt * 1000 <= now) usedJtis.delete(jti);
  }
  const url = new URL(request.url ?? '/', BASE_URL);
  const raw = request.method === 'POST' ? await readBody(request) : '';
  const isJson = request.headers['content-type']?.startsWith('application/json') ?? false;
  const jsonBody: Record<string, unknown> = isJson && raw ? JSON.parse(raw) : {};
  if (url.pathname !== '/test/requests') {
    recordedRequests.push({
      method: request.method ?? 'GET',
      path: url.pathname,
      // The recorded body never keeps an assertion or a code verifier.
      body: Object.fromEntries(
        Object.entries(jsonBody).filter(
          ([key]) => !['client_assertion', 'assertion', 'code_verifier', 'code'].includes(key)
        )
      ),
      at: new Date().toISOString(),
    });
  }

  if (
    await handleBilling(
      request.method ?? 'GET',
      url,
      jsonBody,
      raw,
      request.headers.authorization,
      typeof request.headers['anthropic-user-profile-id'] === 'string'
        ? request.headers['anthropic-user-profile-id']
        : undefined,
      typeof request.headers['anthropic-beta'] === 'string'
        ? request.headers['anthropic-beta']
        : undefined,
      response
    )
  )
    return;
  if (request.method === 'GET' && url.pathname === '/users/.well-known/openid-configuration') {
    send(response, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${BASE_URL}/oauth/authorize`,
      token_endpoint: `${BASE_URL}/v1/oauth/token`,
      jwks_uri: `${ISSUER}/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      id_token_signing_alg_values_supported: ['ES256'],
      scopes_supported: ['openid', 'email'],
      subject_types_supported: ['public', 'pairwise'],
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/users/jwks.json') {
    send(response, 200, {
      keys: [
        {
          ...idTokenKeys.publicKey.export({ format: 'jwk' }),
          kid: ID_TOKEN_KID,
          alg: 'ES256',
          use: 'sig',
        },
      ],
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
    handleAuthorize(url, response);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/oauth/authorize/decision') {
    handleDecision(new URLSearchParams(raw), response);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/oauth/token') {
    handleToken(jsonBody, response);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/test/requests') {
    send(response, 200, recordedRequests);
    return;
  }
  send(response, 404, { error: 'not_found', path: url.pathname });
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch(() => {
    if (response.headersSent) response.destroy();
    else send(response, 400, { error: 'invalid_request' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`mock Anthropic listening on ${BASE_URL} (issuer ${ISSUER})`);
});
