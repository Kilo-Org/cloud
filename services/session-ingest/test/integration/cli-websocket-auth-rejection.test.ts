import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { SESSION_INGEST_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';

import { app } from '../../src/app';
import type { Env } from '../../src/env';

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';
const INVALID_TOKEN = 'not-a-jwt';
const CLI_URL = 'http://local/api/user/cli';

// Only the bindings the auth middleware reads. Signature and audience checks
// reject most tokens before the pepper lookup. The connection string points at
// a local port nothing listens on, so a token that reaches the lookup meets a
// database outage. The fixture stands in for the Worker's full binding set.
const env = {
  NEXTAUTH_SECRET_PROD: { get: async () => TEST_JWT_SECRET },
  HYPERDRIVE: { connectionString: 'postgres://postgres:postgres@127.0.0.1:1/postgres' },
} as unknown as Env;

async function signClaims(
  claims: Record<string, unknown>,
  secret = TEST_JWT_SECRET
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(secret));
}

function signAudienceToken(aud: unknown): Promise<string> {
  return signClaims({
    version: 3,
    kiloUserId: 'usr_4401',
    apiTokenPepper: 'pepper',
    env: 'production',
    aud,
  });
}

function cliUpgradeRequest(query = ''): Request {
  return new Request(`${CLI_URL}${query}`, {
    headers: { Upgrade: 'websocket' },
  });
}

type CloseEvent = { code: number; reason: string };

/** Accept the upgraded client end and report the close frame it receives. */
async function receivedClose(response: Response): Promise<CloseEvent> {
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`expected a 101 upgrade response, got ${response.status}`);
  }
  const client = response.webSocket;
  client.accept();
  const { promise, resolve } = Promise.withResolvers<CloseEvent>();
  client.addEventListener('close', event => resolve({ code: event.code, reason: event.reason }));
  return await promise;
}

describe('CLI websocket authentication rejection', () => {
  it('closes an unauthenticated CLI websocket with 4401', async () => {
    const response = await app.fetch(cliUpgradeRequest(), env);

    expect(response.status).toBe(101);
    await expect(receivedClose(response)).resolves.toEqual({ code: 4401, reason: 'unauthorized' });
  });

  it('closes a CLI websocket with an invalid token with 4401', async () => {
    const response = await app.fetch(cliUpgradeRequest(`?token=${INVALID_TOKEN}`), env);

    expect(response.status).toBe(101);
    await expect(receivedClose(response)).resolves.toEqual({ code: 4401, reason: 'unauthorized' });
  });

  it('closes a CLI websocket whose token has the wrong signature with 4401', async () => {
    const token = await signClaims(
      { version: 3, kiloUserId: 'usr_4401', apiTokenPepper: 'pepper', env: 'production' },
      'wrong-secret-that-is-long-enough-for-hs256'
    );
    const response = await app.fetch(cliUpgradeRequest(`?token=${token}`), env);

    expect(response.status).toBe(101);
    await expect(receivedClose(response)).resolves.toEqual({ code: 4401, reason: 'unauthorized' });
  });

  it.each(['cloud-agent-next', 'kilo-api', null])(
    'closes a CLI websocket with a %s audience token with 4401 before any user lookup',
    async audience => {
      const response = await app.fetch(
        cliUpgradeRequest(`?token=${await signAudienceToken(audience)}`),
        env
      );

      expect(response.status).toBe(101);
      await expect(receivedClose(response)).resolves.toEqual({
        code: 4401,
        reason: 'unauthorized',
      });
    }
  );

  it('does not fall back from an invalid bearer to a valid websocket query token', async () => {
    const queryToken = await signAudienceToken(SESSION_INGEST_AUDIENCE);
    const response = await app.fetch(
      new Request(`http://local/api/user/cli?token=${queryToken}`, {
        headers: { Authorization: `Bearer ${INVALID_TOKEN}`, Upgrade: 'websocket' },
      }),
      env
    );

    expect(response.status).toBe(101);
    await expect(receivedClose(response)).resolves.toEqual({ code: 4401, reason: 'unauthorized' });
  });

  it('keeps the JSON 401 for a non-upgrade CLI request with an invalid token', async () => {
    const response = await app.fetch(
      new Request('http://local/api/user/cli?token=unused', {
        headers: { Authorization: `Bearer ${INVALID_TOKEN}` },
      }),
      env
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Invalid or expired token',
    });
  });

  it('keeps the JSON 401 for another route that fails authentication on a websocket upgrade', async () => {
    const response = await app.fetch(
      new Request('http://local/api/sessions/active', {
        headers: { Authorization: `Bearer ${INVALID_TOKEN}`, Upgrade: 'websocket' },
      }),
      env
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Invalid or expired token',
    });
  });

  it('keeps a retryable 503 for a CLI websocket whose user lookup fails', async () => {
    // A correctly signed token reaches the pepper lookup, and the fixture's
    // database refuses connections.
    const response = await app.fetch(
      cliUpgradeRequest(`?token=${await signAudienceToken(SESSION_INGEST_AUDIENCE)}`),
      env
    );

    expect(response.status).toBe(503);
    expect(response.webSocket).toBeNull();
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Service temporarily unavailable',
    });
  });

  it.each([
    ['a POST', new Request(CLI_URL, { method: 'POST', headers: { Upgrade: 'websocket' } })],
    ['a mixed-case Upgrade value', new Request(CLI_URL, { headers: { Upgrade: 'WebSocket' } })],
    ['a trailing-slash path', new Request(`${CLI_URL}/`, { headers: { Upgrade: 'websocket' } })],
  ])('keeps the HTTP 401 without a socket for %s', async (_name, request) => {
    const response = await app.fetch(request, env);

    expect(response.status).toBe(401);
    expect(response.webSocket).toBeNull();
  });
});
