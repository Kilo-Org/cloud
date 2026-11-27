import { describe, expect, it } from 'vitest';
import type { ManagerLoginJwtResult } from '../../src/dos/UtsManagerAuthDO';
import { ManagerClient, rotationSecretName } from '../../src/manager/client';
import type { ManagerConfig } from '../../src/manager/config';

const CONFIG: ManagerConfig = {
  baseUrl: 'https://manager.test',
  projectId: 'project-1',
  environmentSlug: 'staging',
  identityId: '49efdbc2-f186-4ae0-ba06-941d4b311b21',
  login: {
    issuer: 'https://uts.test/manager-auth',
    subject: 'uts:staging:rotation',
    audience: 'https://eu.infisical.com/identities/49efdbc2-f186-4ae0-ba06-941d4b311b21',
  },
};

const NAME = 'uts_app_a_20261126_030512';
const VALUE = 'synthetic-password-value';

type Call = { method: string; url: URL; body: unknown; authorization: string | null };

/** A stand-in manager: answers login with a token and every other request with `answer`. */
function standIn(answer: (call: Call) => Response, login: () => Response = loginOk) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      authorization: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    return url.pathname === '/api/v1/auth/jwt-auth/login' ? login() : answer(call);
  };
  return { calls, fetcher };
}

function loginOk(): Response {
  return Response.json({ accessToken: 'access-1', expiresIn: 600, tokenType: 'Bearer' });
}

const signed = async (): Promise<ManagerLoginJwtResult> => ({ status: 'signed', jwt: 'login-jwt' });

describe('ManagerClient', () => {
  it('logs in once with the login JWT and creates the secret in /admin/identity-store only', async () => {
    const manager = standIn(() => Response.json({ secret: { id: 'secret-1' } }));
    const client = new ManagerClient(CONFIG, signed, manager.fetcher);
    expect(await client.createIdentityStoreSecret(NAME, VALUE)).toEqual({ status: 'created' });
    expect(await client.describeIdentityStoreSecret(NAME)).toEqual({ status: 'present' });

    const [login, create, describe] = manager.calls;
    expect(manager.calls).toHaveLength(3);
    expect(login?.body).toEqual({ identityId: CONFIG.identityId, jwt: 'login-jwt' });
    expect(create?.method).toBe('POST');
    expect(create?.url.pathname).toBe(`/api/v4/secrets/${NAME}`);
    expect(create?.authorization).toBe('Bearer access-1');
    expect(create?.body).toEqual({
      projectId: 'project-1',
      environment: 'staging',
      secretPath: '/admin/identity-store',
      secretValue: VALUE,
      type: 'shared',
    });
    expect(describe?.url.searchParams.get('secretPath')).toBe('/admin/identity-store');
    expect(describe?.url.searchParams.get('viewSecretValue')).toBe('false');
  });

  it('reports a write that waits for approval, and a secret that does not exist yet', async () => {
    const manager = standIn(call =>
      call.method === 'POST'
        ? Response.json({ approval: { id: 'approval-1', status: 'open' } })
        : Response.json({ message: 'Secret not found' }, { status: 404 })
    );
    const client = new ManagerClient(CONFIG, signed, manager.fetcher);
    expect(await client.createIdentityStoreSecret(NAME, VALUE)).toEqual({
      status: 'approval_pending',
    });
    expect(await client.describeIdentityStoreSecret(NAME)).toEqual({ status: 'missing' });
  });

  it('reads one login seed from /db-switch/uts only, with its value', async () => {
    const manager = standIn(call =>
      call.url.pathname === '/api/v4/secrets/uts_app_b'
        ? Response.json({ secret: { secretKey: 'uts_app_b', secretValue: 'seed-value' } })
        : Response.json({ message: 'Secret not found' }, { status: 404 })
    );
    const client = new ManagerClient(CONFIG, signed, manager.fetcher);
    expect(await client.readLoginSeed('uts_app_b')).toEqual({
      status: 'present',
      value: 'seed-value',
    });
    expect(await client.readLoginSeed('uts_pat_a')).toEqual({ status: 'missing' });
    const read = manager.calls[1];
    expect(read?.method).toBe('GET');
    expect(read?.url.searchParams.get('secretPath')).toBe('/db-switch/uts');
    expect(read?.url.searchParams.get('viewSecretValue')).toBe('true');
    expect(read?.authorization).toBe('Bearer access-1');
    await expect(client.readLoginSeed('uts_app_b_20261126_030512')).rejects.toThrow();
  });

  it('reports 429 and 5xx as unreachable, with the Retry-After of a 429', async () => {
    const busy = standIn(
      () => new Response(null, { status: 429, headers: { 'retry-after': '7' } })
    );
    expect(
      await new ManagerClient(CONFIG, signed, busy.fetcher).createIdentityStoreSecret(NAME, VALUE)
    ).toEqual({
      status: 'unreachable',
      detail: 'manager create failed with status 429',
      retryAfterMs: 7000,
    });
    const down = standIn(loginOk, () => new Response(null, { status: 502 }));
    expect(
      await new ManagerClient(CONFIG, signed, down.fetcher).describeIdentityStoreSecret(NAME)
    ).toEqual({
      status: 'unreachable',
      detail: 'manager login failed with status 502',
      retryAfterMs: null,
    });
    const offline = new ManagerClient(CONFIG, signed, async () => {
      throw new TypeError('network down');
    });
    expect(await offline.describeIdentityStoreSecret(NAME)).toEqual({
      status: 'unreachable',
      detail: 'manager request failed',
      retryAfterMs: null,
    });
    const noSigner = new ManagerClient(CONFIG, async () => {
      throw new Error('object unavailable');
    });
    expect(await noSigner.describeIdentityStoreSecret(NAME)).toEqual({
      status: 'unreachable',
      detail: 'login JWT could not be signed',
      retryAfterMs: null,
    });
  });

  it('reports a refused login or permission as refused, and logs in again after a 403', async () => {
    const refusedLogin = standIn(loginOk, () =>
      Response.json({ message: 'invalid jwt' }, { status: 401 })
    );
    expect(
      await new ManagerClient(CONFIG, signed, refusedLogin.fetcher).createIdentityStoreSecret(
        NAME,
        VALUE
      )
    ).toEqual({ status: 'refused', detail: 'manager login failed with status 401' });

    const forbidden = standIn(() => Response.json({ message: 'forbidden' }, { status: 403 }));
    const client = new ManagerClient(CONFIG, signed, forbidden.fetcher);
    const result = await client.createIdentityStoreSecret(NAME, VALUE);
    expect(result).toEqual({ status: 'refused', detail: 'manager create failed with status 403' });
    expect(JSON.stringify(result)).not.toContain(VALUE);
    await client.describeIdentityStoreSecret(NAME);
    expect(forbidden.calls.filter(call => call.url.pathname.endsWith('/login'))).toHaveLength(2);

    const misconfigured = new ManagerClient(
      CONFIG,
      async () => ({ status: 'misconfigured', reason: 'wrong name' }),
      forbidden.fetcher
    );
    expect(await misconfigured.describeIdentityStoreSecret(NAME)).toEqual({
      status: 'refused',
      detail: 'login key object refused its name',
    });
  });

  it('refuses a malformed create answer', async () => {
    const odd = standIn(() => Response.json({ unexpected: true }));
    expect(
      await new ManagerClient(CONFIG, signed, odd.fetcher).createIdentityStoreSecret(NAME, VALUE)
    ).toEqual({ status: 'refused', detail: 'manager create response did not match' });
  });
});

describe('rotationSecretName', () => {
  it('names the login and the UTC request time', () => {
    expect(rotationSecretName('uts_pat_b', new Date('2026-11-26T23:30:05Z'))).toBe(
      'uts_pat_b_20261126_233005'
    );
    expect(() => rotationSecretName('Bad-Login', new Date('2026-11-26T00:00:00Z'))).toThrow();
  });
});
