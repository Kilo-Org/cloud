import { signKiloToken, type SignKiloTokenExtra } from '@kilocode/worker-utils/kilo-token';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { authorize, exchange, type AuthEnv } from './auth';

const NEXTAUTH_SECRET = 'synthetic-nextauth-secret-0123456789abcdef';
const GRANT_SECRET = 'synthetic-session-sync-secret-0123456789abcdef';
const USER = 'oauth/google:synthetic-user';
const ORGANIZATION = '00000000-0000-4000-8000-000000000001';
const PEPPER = 'synthetic-pepper';
const FIVE_YEARS = 157_680_000;
// Nothing listens on port 1, so any database access fails like an outage.
const UNREACHABLE_DATABASE = 'postgresql://synthetic:synthetic@127.0.0.1:1/none';

function env(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    NEXTAUTH_SECRET,
    SESSION_SYNC_SECRET: GRANT_SECRET,
    HYPERDRIVE: { connectionString: UNREACHABLE_DATABASE } as Hyperdrive,
    ENVIRONMENT: 'development',
    ...overrides,
  };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function grant(
  claims: Record<string, unknown> = {},
  options: { secret?: string; alg?: string } = {}
): Promise<string> {
  const now = nowSeconds();
  return new SignJWT({
    version: 1,
    iss: 'session-sync',
    aud: 'session-sync',
    sub: USER,
    iat: now,
    exp: now + 60,
    tenant: { type: 'user', id: USER },
    ...claims,
  })
    .setProtectedHeader({ alg: options.alg ?? 'HS256', typ: 'JWT' })
    .sign(new TextEncoder().encode(options.secret ?? GRANT_SECRET));
}

function dataRequest(token?: string): Request {
  return new Request('https://session-sync.test/v1/sessions/ses_synthetic', {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
}

function exchangeRequest(token: string | undefined, body: unknown = { version: 1 }): Request {
  return new Request('https://session-sync.test/v1/auth/exchange', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function errorCode(result: unknown): Promise<{ status: number; code: unknown }> {
  if (!(result instanceof Response)) throw new Error('Expected an error response');
  const body: { error?: { code?: unknown } } = await result.json();
  return { status: result.status, code: body.error?.code };
}

async function legacyApiToken(
  options: { lifetime?: number; env?: string; extra?: SignKiloTokenExtra } = {}
): Promise<string> {
  const { token } = await signKiloToken({
    userId: USER,
    pepper: PEPPER,
    secret: NEXTAUTH_SECRET,
    expiresInSeconds: options.lifetime ?? FIVE_YEARS,
    env: options.env ?? 'development',
    extra: options.extra ?? { deviceAuthRequestCode: 'SYNTH-0001' },
  });
  return token;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authorize', () => {
  it('returns the principal bound in a personal grant', async () => {
    await expect(authorize(dataRequest(await grant()), env())).resolves.toEqual({
      userID: USER,
      tenant: { type: 'user', id: USER },
    });
  });

  it('returns the organization tenant bound in an organization grant', async () => {
    const token = await grant({ tenant: { type: 'organization', id: ORGANIZATION } });
    await expect(authorize(dataRequest(token), env())).resolves.toEqual({
      userID: USER,
      tenant: { type: 'organization', id: ORGANIZATION },
    });
  });

  it('requires a bearer grant', async () => {
    expect(await errorCode(await authorize(dataRequest(), env()))).toEqual({
      status: 401,
      code: 'unauthenticated',
    });
  });

  it.each<[string, () => Promise<string>]>([
    ['another signing secret', () => grant({}, { secret: `${GRANT_SECRET}-other` })],
    ['the Kilo account secret', () => grant({}, { secret: NEXTAUTH_SECRET })],
    ['a non-HS256 algorithm', () => grant({}, { alg: 'HS384' })],
    ['a foreign audience', () => grant({ aud: 'kilo-api' })],
    ['an audience array', () => grant({ aud: ['session-sync'] })],
    ['a foreign issuer', () => grant({ iss: 'kilo' })],
    ['an expired grant', () => grant({ iat: nowSeconds() - 120, exp: nowSeconds() - 60 })],
    ['a lifetime above 60 seconds', () => grant({ exp: nowSeconds() + 61 })],
    ['a future issue time', () => grant({ iat: nowSeconds() + 30, exp: nowSeconds() + 60 })],
    ['a fractional issue time', () => grant({ iat: nowSeconds() - 0.5 })],
    ['a missing subject', () => grant({ sub: undefined })],
    ['an unknown claim', () => grant({ admin: true })],
    ['an unknown protocol version', () => grant({ version: 2 })],
    ['a personal tenant for another user', () => grant({ tenant: { type: 'user', id: 'other' } })],
    [
      'a malformed organization tenant',
      () => grant({ tenant: { type: 'organization', id: 'not-a-uuid' } }),
    ],
    ['an extra tenant field', () => grant({ tenant: { type: 'user', id: USER, role: 'owner' } })],
    ['a raw Kilo API credential', () => legacyApiToken()],
  ])('rejects a grant with %s', async (_name, token) => {
    expect(await errorCode(await authorize(dataRequest(await token()), env()))).toEqual({
      status: 401,
      code: 'invalid_grant',
    });
  });

  it('reports a weak or missing grant secret as unavailable, not invalid', async () => {
    const token = await grant({}, { secret: 'short' });
    expect(
      await errorCode(await authorize(dataRequest(token), env({ SESSION_SYNC_SECRET: 'short' })))
    ).toEqual({ status: 503, code: 'auth_unavailable' });
  });

  it('retries a failed secret fetch and caches only the resolved value', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const get = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('secret store unavailable'))
      .mockResolvedValue(GRANT_SECRET);
    const bindingEnv = env({ SESSION_SYNC_SECRET: { get } });
    const token = await grant();

    expect(await errorCode(await authorize(dataRequest(token), bindingEnv))).toEqual({
      status: 503,
      code: 'auth_unavailable',
    });
    await expect(authorize(dataRequest(token), bindingEnv)).resolves.toMatchObject({
      userID: USER,
    });
    await expect(authorize(dataRequest(token), bindingEnv)).resolves.toMatchObject({
      userID: USER,
    });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('exchange', () => {
  it('requires a Kilo bearer credential', async () => {
    expect(await errorCode(await exchange(exchangeRequest(undefined), env()))).toEqual({
      status: 401,
      code: 'unauthenticated',
    });
  });

  it.each<[string, unknown, number, string]>([
    ['invalid JSON', '{', 400, 'invalid_request'],
    ['an unknown protocol version', { version: 2 }, 400, 'invalid_request'],
    ['a client-supplied user', { version: 1, userID: 'other' }, 400, 'invalid_request'],
    ['a malformed organization', { version: 1, organizationID: 'org' }, 400, 'invalid_request'],
    [
      'an oversized body',
      { version: 1, organizationID: 'x'.repeat(2048) },
      413,
      'payload_too_large',
    ],
  ])('rejects %s', async (_name, body, status, code) => {
    const response = await exchange(exchangeRequest(await legacyApiToken(), body), env());
    expect(await errorCode(response)).toEqual({ status, code });
  });

  it.each<[string, () => Promise<string>, number, string]>([
    [
      'a forged signature',
      async () =>
        (
          await signKiloToken({
            userId: USER,
            pepper: PEPPER,
            secret: `${NEXTAUTH_SECRET}-forged`,
            expiresInSeconds: FIVE_YEARS,
            env: 'development',
          })
        ).token,
      401,
      'invalid_credential',
    ],
    [
      'an expired credential',
      () =>
        new SignJWT({
          version: 3,
          kiloUserId: USER,
          apiTokenPepper: PEPPER,
          env: 'development',
          iat: nowSeconds() - FIVE_YEARS - 60,
          exp: nowSeconds() - 60,
        })
          .setProtectedHeader({ alg: 'HS256' })
          .sign(new TextEncoder().encode(NEXTAUTH_SECRET)),
      401,
      'invalid_credential',
    ],
    [
      'a gateway audience',
      async () =>
        (
          await signModernKiloToken({
            userId: USER,
            pepper: PEPPER,
            secret: NEXTAUTH_SECRET,
            env: 'development',
            expiresInSeconds: 3600,
            audience: 'kilo-gateway',
            tokenPurpose: 'human-api',
            credentialExchange: false,
          })
        ).token,
      401,
      'invalid_credential',
    ],
    ['another environment', () => legacyApiToken({ env: 'production' }), 401, 'invalid_credential'],
    [
      'a delegated workload credential',
      async () =>
        (
          await signModernKiloToken({
            userId: USER,
            pepper: PEPPER,
            secret: NEXTAUTH_SECRET,
            env: 'development',
            expiresInSeconds: 3600,
            audience: 'kilo-api',
            tokenPurpose: 'delegated-workload',
            credentialExchange: false,
          })
        ).token,
      403,
      'unsupported_credential',
    ],
    [
      'a multi-audience credential',
      async () =>
        (
          await signModernKiloToken({
            userId: USER,
            pepper: PEPPER,
            secret: NEXTAUTH_SECRET,
            env: 'development',
            expiresInSeconds: 3600,
            audience: ['kilo-api', 'kilo-gateway'],
            tokenPurpose: 'human-api',
            credentialExchange: false,
          })
        ).token,
      403,
      'unsupported_credential',
    ],
    [
      'a service credential without a pepper',
      async () =>
        (
          await signKiloToken({
            userId: USER,
            secret: NEXTAUTH_SECRET,
            expiresInSeconds: FIVE_YEARS,
            env: 'development',
          })
        ).token,
      403,
      'unsupported_credential',
    ],
    [
      'a bot credential',
      () => legacyApiToken({ extra: { botId: 'reviewer' } }),
      403,
      'unsupported_credential',
    ],
    [
      'an organization-scoped credential',
      () => legacyApiToken({ extra: { organizationId: ORGANIZATION, organizationRole: 'owner' } }),
      403,
      'unsupported_credential',
    ],
    [
      'a short-lived legacy credential without a device session',
      () => legacyApiToken({ lifetime: 3600 }),
      403,
      'unsupported_credential',
    ],
    [
      'a device credential with an unknown lifetime',
      () =>
        legacyApiToken({
          lifetime: 30 * 24 * 3600,
          extra: { deviceSessionId: '00000000-0000-4000-8000-000000000002' },
        }),
      403,
      'unsupported_credential',
    ],
  ])('rejects %s before any account lookup', async (_name, token, status, code) => {
    const response = await exchange(exchangeRequest(await token()), env());
    expect(await errorCode(response)).toEqual({ status, code });
  });

  it('reports an account database outage as unavailable without logging secrets', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const token = await legacyApiToken();
    const response = await exchange(
      exchangeRequest(token, { version: 1, organizationID: ORGANIZATION }),
      env()
    );

    expect(await errorCode(response)).toEqual({ status: 503, code: 'auth_unavailable' });
    const logged = JSON.stringify(log.mock.calls);
    for (const secret of [token, NEXTAUTH_SECRET, GRANT_SECRET, PEPPER, UNREACHABLE_DATABASE]) {
      expect(logged).not.toContain(secret);
    }
  });

  it('enforces the credential environment only when one is configured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const token = await legacyApiToken({ env: 'production' });
    const response = await exchange(exchangeRequest(token), env({ ENVIRONMENT: undefined }));
    expect(await errorCode(response)).toEqual({ status: 503, code: 'auth_unavailable' });
  });

  it('refuses to issue grants with a weak grant secret', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await exchange(
      exchangeRequest(await legacyApiToken()),
      env({ SESSION_SYNC_SECRET: 'short' })
    );
    expect(await errorCode(response)).toEqual({ status: 503, code: 'auth_unavailable' });
  });
});
