import { createExecutionContext } from 'cloudflare:test';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Env } from '../../src/env';
import { handleRequest } from '../../src/http';
import { MANAGER_IDENTITIES, MANAGER_JWKS_PATH, managerConfig } from '../../src/manager/config';
import { resetManagerKeySet, signManagerLoginJwt } from '../../src/manager/key-set';
import { config, env } from './test-env';

const JwksSchema = z.strictObject({
  keys: z.array(
    z.strictObject({
      kty: z.literal('EC'),
      crv: z.literal('P-256'),
      x: z.string(),
      y: z.string(),
      kid: z.string(),
      alg: z.literal('ES256'),
      use: z.literal('sig'),
    })
  ),
});

const fetchKeySet = (target: Env = env, init?: RequestInit) =>
  handleRequest(
    new Request(`${config.endpoints.issuer}${MANAGER_JWKS_PATH}`, init),
    target,
    createExecutionContext()
  );

/**
 * A namespace whose objects all open under another environment's name, as a binding that points at
 * the wrong objects would. Only the members the stub helpers call are present, so the type is
 * asserted.
 */
const misnamedEnv: Env = {
  ...env,
  UTS_MANAGER_AUTH_DO: {
    jurisdiction: () => misnamedEnv.UTS_MANAGER_AUTH_DO,
    idFromName: () => env.UTS_MANAGER_AUTH_DO.idFromName('staging:manager-auth'),
    get: (id: DurableObjectId) => env.UTS_MANAGER_AUTH_DO.get(id),
  } as unknown as Env['UTS_MANAGER_AUTH_DO'],
};

/**
 * `target` with a manager namespace that counts the stubs it hands out, so a test sees how often a
 * key-set read reaches the key object. Only the members the stub helpers call are present, so the
 * type is asserted.
 */
function counted(target: Env): { env: Env; stubs: () => number } {
  const namespace = target.UTS_MANAGER_AUTH_DO;
  let stubs = 0;
  const wrapped = {
    jurisdiction: () => wrapped,
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) => {
      stubs += 1;
      return namespace.get(id, options);
    },
  } as unknown as Env['UTS_MANAGER_AUTH_DO'];
  return { env: { ...target, UTS_MANAGER_AUTH_DO: wrapped }, stubs: () => stubs };
}

afterEach(() => {
  resetManagerKeySet();
});

// The cases share one object and run in order: the empty set before the first login creates the
// key, then the key the login created.
describe('manager login key', () => {
  it('serves an empty key set with no-store before the first login, and keeps it a few seconds', async () => {
    const counting = counted(env);
    for (let read = 0; read < 3; read++) {
      const response = await fetchKeySet(counting.env);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(JwksSchema.parse(await response.json())).toEqual({ keys: [] });
    }
    expect(counting.stubs()).toBe(1);
  });

  it('answers 503, never 500, when the key object refuses its name, and keeps the failure briefly', async () => {
    const counting = counted(misnamedEnv);
    for (let read = 0; read < 2; read++) {
      const response = await fetchKeySet(counting.env);
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('30');
      expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
    }
    expect(counting.stubs()).toBe(1);
    expect(await signManagerLoginJwt(misnamedEnv, config)).toEqual({
      status: 'misconfigured',
      reason: 'manager auth object was not created by its name in this environment',
    });
  });

  it('logs only the error name and a fixed message when the key object throws', async () => {
    const throwing: Env = {
      ...env,
      UTS_MANAGER_AUTH_DO: {
        jurisdiction: () => throwing.UTS_MANAGER_AUTH_DO,
        idFromName: (name: string) => env.UTS_MANAGER_AUTH_DO.idFromName(name),
        get: () => ({
          jwks: async () => {
            throw new TypeError('transport detail');
          },
        }),
      } as unknown as Env['UTS_MANAGER_AUTH_DO'],
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await fetchKeySet(throwing);
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('30');
      const lines = error.mock.calls
        .map(([line]) => line)
        .filter(line => typeof line === 'string' && line.includes('uts.manager_auth.jwks_failed'));
      expect(lines.map(line => JSON.parse(String(line)))).toEqual([
        {
          event: 'uts.manager_auth.jwks_failed',
          error: 'TypeError',
          message: 'manager key object did not answer',
        },
      ]);
    } finally {
      error.mockRestore();
    }
  });

  it('refuses a method other than GET', async () => {
    const response = await fetchKeySet(env, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });

  it('signs a login JWT that verifies against the published set with the exact claims', async () => {
    // The isolate holds the empty set; the signed login drops it, so the next read has the key.
    expect(JwksSchema.parse(await (await fetchKeySet()).json())).toEqual({ keys: [] });
    const signed = await signManagerLoginJwt(env, config);
    if (signed.status !== 'signed') throw new Error(`login JWT not signed: ${signed.status}`);
    const response = await fetchKeySet();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    const jwks = JwksSchema.parse(await response.json());
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).not.toHaveProperty('d');

    const identityId = MANAGER_IDENTITIES.development.identityId;
    const { payload, protectedHeader } = await jwtVerify(signed.jwt, createLocalJWKSet(jwks), {
      algorithms: ['ES256'],
      issuer: `${config.endpoints.issuer}/manager-auth`,
      subject: 'uts:development:rotation',
      audience: `https://eu.infisical.com/identities/${identityId}`,
    });
    expect(protectedHeader).toEqual({ alg: 'ES256', kid: jwks.keys[0]?.kid, typ: 'JWT' });
    expect(payload.aud).toBe(`https://eu.infisical.com/identities/${identityId}`);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(120);
    expect(z.uuid().safeParse(payload.jti).success).toBe(true);
  });

  it('keeps the same key across logins and serves it from the isolate copy', async () => {
    const first = await signManagerLoginJwt(env, config);
    const second = await signManagerLoginJwt(env, config);
    if (first.status !== 'signed' || second.status !== 'signed') throw new Error('not signed');
    expect(first.jwt).not.toBe(second.jwt);
    expect(decodeProtectedHeader(first.jwt).kid).toBe(decodeProtectedHeader(second.jwt).kid);
    const jwks = JwksSchema.parse(await (await fetchKeySet()).json());
    expect(jwks.keys.map(key => key.kid)).toEqual([decodeProtectedHeader(first.jwt).kid]);
  });
});

describe('manager config', () => {
  it('names each environment identity, its audience and its issuer', () => {
    const production = { ...config, environment: 'production' as const, managerBaseUrl: null };
    expect(
      managerConfig({
        ...production,
        endpoints: { ...config.endpoints, issuer: 'https://uts.kiloapps.io' },
      })
    ).toEqual({
      baseUrl: 'https://eu.infisical.com',
      projectId: '8cf601df-1c5a-4c8f-9e21-7e9af6728b06',
      environmentSlug: 'production',
      identityId: '35559137-4dbb-466e-9673-1d9ecd3d3ec5',
      login: {
        issuer: 'https://uts.kiloapps.io/manager-auth',
        subject: 'uts:production:rotation',
        audience: 'https://eu.infisical.com/identities/35559137-4dbb-466e-9673-1d9ecd3d3ec5',
      },
    });
    expect(MANAGER_IDENTITIES.staging.identityId).toBe('49efdbc2-f186-4ae0-ba06-941d4b311b21');
    expect(managerConfig({ ...config, managerBaseUrl: null })).toBeNull();
  });
});
