import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
} from 'jose';
import type * as SignInProvider from './sign-in-provider';

type SignInProviderModule = typeof SignInProvider;

const CLIENT_ID = 'claude-sign-in-test-client';
const ASSERTION_AUDIENCE = 'https://auth.test/claude-sign-in-audience';
const FEDERATION_ISSUER = 'https://kilo.test/claude-federation';

let server: Server;
let issuer = '';
let jwksUri = '';
let idTokenKey: CryptoKey;
let federationPublicJwk: JWK;
let tokenResponse: { status: number; body: unknown } = { status: 200, body: {} };
let lastTokenRequest: { contentType: string | undefined; body: Record<string, unknown> } | null =
  null;
let provider: SignInProviderModule;

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function signIdToken(
  claims: Record<string, unknown>,
  options: { key?: CryptoKey; issuer?: string; audience?: string; expiresIn?: string } = {}
) {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'id-token-key' })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? CLIENT_ID)
    .setSubject('pairwise-sub-123')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '10m')
    .sign(options.key ?? idTokenKey);
}

beforeAll(async () => {
  const idTokenKeys = await generateKeyPair('ES256', { extractable: true });
  idTokenKey = idTokenKeys.privateKey;
  const idTokenPublicJwk = { ...(await exportJWK(idTokenKeys.publicKey)), kid: 'id-token-key' };

  const federationKeys = await generateKeyPair('ES256', { extractable: true });
  federationPublicJwk = await exportJWK(federationKeys.publicKey);

  server = createServer(async (request, response) => {
    if (request.url === '/users/jwks.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ keys: [idTokenPublicJwk] }));
      return;
    }
    if (request.url === '/v1/oauth/token' && request.method === 'POST') {
      lastTokenRequest = {
        contentType: request.headers['content-type'],
        body: await readJson(request),
      };
      response.writeHead(tokenResponse.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(tokenResponse.body));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  issuer = `${baseUrl}/users`;
  jwksUri = `${issuer}/jwks.json`;

  process.env.CLAUDE_OIDC_ISSUER = issuer;
  process.env.CLAUDE_AUTH_BASE_URL = baseUrl;
  process.env.CLAUDE_SIGN_IN_CLIENT_ID = CLIENT_ID;
  process.env.CLAUDE_SIGN_IN_ASSERTION_AUDIENCE = ASSERTION_AUDIENCE;
  process.env.CLAUDE_FEDERATION_ISSUER = FEDERATION_ISSUER;
  process.env.CLAUDE_FEDERATION_SUBJECT = 'kilo-web';
  process.env.CLAUDE_FEDERATION_KEY_ID = 'kilo-federation-1';
  process.env.CLAUDE_FEDERATION_PRIVATE_KEY = await exportPKCS8(federationKeys.privateKey);

  // Dynamic import: the configuration is read at module load, so the module
  // must load after the environment points at this test server.
  provider = await import('./sign-in-provider');
});

afterAll(async () => {
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
});

describe('parseClaudeProfile', () => {
  test('binds the account to the pairwise subject and falls back to the email local part', () => {
    expect(provider.parseClaudeProfile({ sub: 'pairwise-sub', email: 'ada@example.com' })).toEqual({
      id: 'pairwise-sub',
      email: 'ada@example.com',
      name: 'ada',
      image: null,
    });
  });

  test.each([
    [{ email: 'ada@example.com' }, 'no subject'],
    [{ sub: '  ', email: 'ada@example.com' }, 'a blank subject'],
    [{ sub: 'pairwise-sub' }, 'no email'],
  ])('rejects a profile with %s (%s)', (profile, _reason) => {
    expect(() => provider.parseClaudeProfile(profile)).toThrow();
  });
});

describe('verifyClaudeIdToken', () => {
  test('accepts a token signed by the discovery JWKS for this client and nonce', async () => {
    const idToken = await signIdToken({ nonce: 'nonce-1', email: 'ada@example.com' });
    const payload = await provider.verifyClaudeIdToken({ idToken, jwksUri, nonce: 'nonce-1' });
    expect(payload.sub).toBe('pairwise-sub-123');
  });

  test('rejects a token whose nonce differs from the authorization request', async () => {
    const idToken = await signIdToken({ nonce: 'nonce-1' });
    await expect(
      provider.verifyClaudeIdToken({ idToken, jwksUri, nonce: 'other' })
    ).rejects.toThrow('nonce');
  });

  test('rejects a token without a nonce', async () => {
    const idToken = await signIdToken({});
    await expect(
      provider.verifyClaudeIdToken({ idToken, jwksUri, nonce: 'nonce-1' })
    ).rejects.toThrow();
  });

  test.each([
    ['another audience', { audience: 'another-client' }],
    ['another issuer', { issuer: 'https://attacker.test/users' }],
    ['an expired token', { expiresIn: '-1m' }],
  ])('rejects %s', async (_label, options) => {
    const idToken = await signIdToken({ nonce: 'nonce-1' }, options);
    await expect(
      provider.verifyClaudeIdToken({ idToken, jwksUri, nonce: 'nonce-1' })
    ).rejects.toThrow();
  });

  test('rejects a token signed by a key outside the JWKS', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const idToken = await signIdToken({ nonce: 'nonce-1' }, { key: privateKey });
    await expect(
      provider.verifyClaudeIdToken({ idToken, jwksUri, nonce: 'nonce-1' })
    ).rejects.toThrow();
  });
});

describe('exchangeClaudeSignInCode', () => {
  test('redeems the code with a JSON body and a Kilo-signed client assertion', async () => {
    tokenResponse = {
      status: 200,
      body: {
        access_token: 'at',
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: 'idt',
        scope: 'openid email',
      },
    };

    const tokens = await provider.exchangeClaudeSignInCode({
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: 'https://app.test/api/auth/callback/claude',
    });

    expect(tokens.id_token).toBe('idt');
    expect(lastTokenRequest?.contentType).toBe('application/json');
    const body = lastTokenRequest?.body ?? {};
    expect(body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-1',
      code_verifier: 'verifier-1',
      redirect_uri: 'https://app.test/api/auth/callback/claude',
      client_id: CLIENT_ID,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    });
    expect(body).not.toHaveProperty('client_secret');

    const { payload, protectedHeader } = await jwtVerify(
      String(body.client_assertion),
      await importJWK(federationPublicJwk, 'ES256'),
      { issuer: FEDERATION_ISSUER, audience: ASSERTION_AUDIENCE, subject: 'kilo-web' }
    );
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'kilo-federation-1' });
    // A single audience string: auth.claude.com rejects an audience list.
    expect(payload.aud).toBe(ASSERTION_AUDIENCE);
    expect(typeof payload.jti).toBe('string');
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(300);
  });

  test('mints a fresh assertion for every exchange', async () => {
    tokenResponse = {
      status: 200,
      body: { access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: 'idt' },
    };
    const exchange = () =>
      provider.exchangeClaudeSignInCode({
        code: 'c',
        codeVerifier: 'v',
        redirectUri: 'https://app.test/cb',
      });

    await exchange();
    const first = lastTokenRequest?.body.client_assertion;
    await exchange();
    expect(lastTokenRequest?.body.client_assertion).not.toBe(first);
  });

  test('reports only the OAuth error code of a refused exchange', async () => {
    tokenResponse = {
      status: 400,
      body: { error: 'invalid_grant', error_description: 'echoed code-1 and verifier-1' },
    };
    const error = await provider
      .exchangeClaudeSignInCode({
        code: 'code-1',
        codeVerifier: 'verifier-1',
        redirectUri: 'https://app.test/cb',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : '';
    expect(message).toBe('Claude token exchange failed with HTTP 400 (invalid_grant)');
  });

  test('rejects a success response without an ID token', async () => {
    tokenResponse = {
      status: 200,
      body: { access_token: 'at', token_type: 'Bearer', expires_in: 3600 },
    };
    await expect(
      provider.exchangeClaudeSignInCode({
        code: 'c',
        codeVerifier: 'v',
        redirectUri: 'https://app.test/cb',
      })
    ).rejects.toThrow('malformed');
  });
});

describe('Claude callback binding', () => {
  test.each([undefined, 'other-browser-state'])(
    'refuses a callback with state %s before exchanging the code',
    async state => {
      const token = provider.claudeSignInProvider.token;
      if (!token || typeof token === 'string' || !token.request)
        throw new Error('Expected a custom code exchange');
      await expect(
        token.request({
          params: { code: 'one-use-code', state },
          checks: { state: 'browser-state', code_verifier: 'verifier', nonce: 'nonce' },
        } as never)
      ).rejects.toThrow('state does not match');
    }
  );
});
