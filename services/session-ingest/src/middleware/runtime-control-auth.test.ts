import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';

import { SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE } from '@kilocode/session-ingest-contracts';

import { runtimeControlAuthMiddleware } from './runtime-control-auth';
import { runtimeControlApi } from '../routes/runtime-control';

vi.mock('../dos/UserConnectionDO', () => ({
  getUserConnectionDO: vi.fn(),
}));

import { getUserConnectionDO as mockGetUserConnectionDO } from '../dos/UserConnectionDO';

const SECRET = 'test-secret-at-least-32-characters-long';
const NEXTAUTH_SECRET_PROD = SECRET;

function encode(secret: string) {
  return new TextEncoder().encode(secret);
}

async function signWithAudience(audience?: string, expiresIn = '5m') {
  let builder = new SignJWT({ version: 3, kiloUserId: 'usr_internal' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt();
  if (audience) builder = builder.setAudience(audience);
  builder = builder.setExpirationTime(expiresIn);
  return builder.sign(encode(SECRET));
}

function makeApp() {
  const app = new Hono<{ Bindings: { NEXTAUTH_SECRET_PROD: { get: () => Promise<string> } } }>();
  app.use('/internal/runtime-control/*', runtimeControlAuthMiddleware);
  app.route('/internal/runtime-control', runtimeControlApi);
  return app;
}

function makeEnv() {
  return {
    NEXTAUTH_SECRET_PROD: { get: vi.fn(async () => NEXTAUTH_SECRET_PROD) },
  };
}

describe('runtime-control auth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const doInstance = { getRuntimePresence: vi.fn(async () => []) };
    vi.mocked(mockGetUserConnectionDO).mockReturnValue(doInstance as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await makeApp().request(
      'http://local/internal/runtime-control/runtimes',
      { method: 'GET' },
      makeEnv()
    );
    expect(res.status).toBe(401);
  });

  it('rejects a request with a malformed Authorization header', async () => {
    const res = await makeApp().request(
      'http://local/internal/runtime-control/runtimes',
      { method: 'GET', headers: { Authorization: 'NotBearer abc' } },
      makeEnv()
    );
    expect(res.status).toBe(401);
  });

  it('rejects an expired token with the correct audience', async () => {
    const token = await signWithAudience(SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE, '0s');
    const res = await makeApp().request(
      'http://local/internal/runtime-control/runtimes',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      makeEnv()
    );
    expect(res.status).toBe(401);
  });

  it('rejects a token without the runtime-control audience', async () => {
    const token = await signWithAudience('some-other-audience');
    const res = await makeApp().request(
      'http://local/internal/runtime-control/runtimes',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      makeEnv()
    );
    expect(res.status).toBe(401);
  });

  it('rejects a token that has no audience at all', async () => {
    const token = await signWithAudience(undefined);
    const res = await makeApp().request(
      'http://local/internal/runtime-control/runtimes',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      makeEnv()
    );
    expect(res.status).toBe(401);
  });

  it('accepts a token with the runtime-control audience and uses the signed userId', async () => {
    const token = await signWithAudience(SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE);
    const res = await makeApp().request(
      'http://local/internal/runtime-control/runtimes',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      makeEnv()
    );
    expect(res.status).toBe(200);
    expect(mockGetUserConnectionDO).toHaveBeenCalledWith(expect.anything(), {
      kiloUserId: 'usr_internal',
    });
  });

  it('does not trust a userId supplied as a query parameter', async () => {
    const token = await signWithAudience(SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE);
    const res = await makeApp().request(
      'http://local/internal/runtime-control/runtimes?kiloUserId=usr_spoofed',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      makeEnv()
    );
    expect(res.status).toBe(200);
    expect(mockGetUserConnectionDO).toHaveBeenCalledWith(expect.anything(), {
      kiloUserId: 'usr_internal',
    });
  });
});

describe('GET /internal/runtime-control/runtimes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the bound user DO runtime list and an empty array on no runtimes', async () => {
    const doInstance = { getRuntimePresence: vi.fn(async () => []) };
    vi.mocked(mockGetUserConnectionDO).mockReturnValue(doInstance as never);

    const token = await signWithAudience(SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE);
    const res = await makeApp().request(
      'http://local/internal/runtime-control/runtimes',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      makeEnv()
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runtimes: [] });
  });

  it('includes zero-session runtimes and capability-missing runtimes', async () => {
    const doInstance = {
      getRuntimePresence: vi.fn(async () => [
        {
          runtimeId: '0c0a1b2c-3d4e-4f60-8a8b-9c0d1e2f3a4b',
          connectionId: 'cli-1',
          protocolVersion: 1,
          cliVersion: '7.4.7',
          displayName: 'Alice Mac',
          projectName: 'customer-repo',
          capabilities: ['catalog.v1', 'create-and-run.v1'],
        },
        {
          runtimeId: '1c0a1b2c-3d4e-4f60-8a8b-9c0d1e2f3a4b',
          connectionId: 'cli-2',
          protocolVersion: 1,
          cliVersion: '7.4.7',
          displayName: 'Bob Mac',
          projectName: 'empty-repo',
          capabilities: ['catalog.v1'],
        },
      ]),
    };
    vi.mocked(mockGetUserConnectionDO).mockReturnValue(doInstance as never);

    const token = await signWithAudience(SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE);
    const res = await makeApp().request(
      'http://local/internal/runtime-control/runtimes',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      makeEnv()
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { runtimes: Array<{ capabilities: string[]; projectName: string }> };
    expect(body.runtimes).toHaveLength(2);
    // Capability-missing entry is still present so the mobile client can
    // surface a precise recovery state.
    expect(body.runtimes[1].capabilities).toEqual(['catalog.v1']);
  });

  it('rejects POST and other methods on the read-only endpoint', async () => {
    const token = await signWithAudience(SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE);
    const res = await makeApp().request(
      'http://local/internal/runtime-control/runtimes',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      makeEnv()
    );
    expect(res.status).toBe(404);
  });

  it('does not include the request body or authorization header in error logs', async () => {
    const token = await signWithAudience(SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const doInstance = { getRuntimePresence: vi.fn(async () => { throw new Error('boom with secret-secret-secret'); }) };
    vi.mocked(mockGetUserConnectionDO).mockReturnValue(doInstance as never);

    const res = await makeApp().request(
      'http://local/internal/runtime-control/runtimes',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      makeEnv()
    );

    expect(res.status).toBe(500);
    const dumped = JSON.stringify({ warns: warn.mock.calls, errors: error.mock.calls, res: await res.clone().text() });
    expect(dumped).not.toContain('secret-secret-secret');
    expect(dumped).not.toContain(token);
  });
});
