import { STS_ISSUERS } from '@kilocode/sts-contracts';
import { resetInternalAuthObservation } from '@kilocode/worker-utils/internal-auth-observation';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  WorkerEntrypoint: class WorkerEntrypoint {},
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

vi.mock('./dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(),
}));

vi.mock('./dos/SessionAccessCacheDO', () => ({
  SessionAccessCacheDO: class SessionAccessCacheDO {},
  getSessionAccessCacheDO: vi.fn(),
}));

vi.mock('./dos/UserConnectionDO', () => ({
  getUserConnectionDO: vi.fn(),
}));

import { app } from './index';
import { getSessionAccessCacheDO } from './dos/SessionAccessCacheDO';
import { getUserConnectionDO } from './dos/UserConnectionDO';
import {
  SESSION_ACCESS_INVALIDATE_SCOPE,
  SESSION_INGEST_STS_AUDIENCE,
  invalidateCredentialAcceptance,
} from './session-access-invalidate-auth';
import { serviceClaims, signToken, testSigner, type TestSigner } from './sts-token.test-fixture';

const ISSUER = STS_ISSUERS.production;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const SECRET = 'synthetic-internal-secret';
const ROUTE = '/internal/session-access/invalidate';
const METADATA_URL = 'https://ingest.kilosessions.ai/.well-known/oauth-protected-resource';
const BODY = JSON.stringify({
  kiloUserId: 'usr_removed',
  organizationId: '11111111-1111-4111-8111-111111111111',
});

let signer: TestSigner;
let invalidateOrganization: Mock<(organizationId: string) => Promise<undefined>>;

beforeAll(async () => {
  signer = await testSigner();
});

beforeEach(() => {
  vi.resetAllMocks();
  resetInternalAuthObservation();
  invalidateOrganization = vi.fn(async () => undefined);
  vi.mocked(getSessionAccessCacheDO).mockReturnValue({
    invalidateOrganization,
  } as unknown as ReturnType<typeof getSessionAccessCacheDO>);
  vi.mocked(getUserConnectionDO).mockReturnValue({
    closeViewerSockets: vi.fn(async () => 0),
  } as unknown as ReturnType<typeof getUserConnectionDO>);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Serves the stand-in key set at the production STS issuer; records every outbound fetch. */
function stubFetch() {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      if (url === JWKS_URL) return Response.json(signer.jwks);
      return new Response('unexpected', { status: 599 });
    })
  );
  return urls;
}

/** The route's env with `vars`; `reads` counts every read of the shared secret. */
function makeEnv(vars: Record<string, string | undefined>) {
  let reads = 0;
  const env = {
    INTERNAL_API_SECRET_PROD: {
      async get() {
        reads += 1;
        return SECRET;
      },
    },
    ...vars,
  };
  return { env, reads: () => reads };
}

async function call(env: object, headers: Record<string, string>) {
  return await app.request(
    ROUTE,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: BODY },
    env
  );
}

/** A `session-ingest` token from `workload` for the invalidation scope, signed by `by`. */
async function token(
  overrides: Record<string, unknown> = {},
  workload = 'web',
  by: TestSigner = signer
) {
  return await signToken(by, {
    ...serviceClaims({
      issuer: ISSUER,
      workload,
      audience: SESSION_INGEST_STS_AUDIENCE,
      scope: SESSION_ACCESS_INVALIDATE_SCOPE,
    }),
    ...overrides,
  });
}

/** Every `kilo_internal_auth` line logged so far, parsed. */
function authLines(log: { mock: { calls: unknown[][] } }) {
  return log.mock.calls
    .map(([line]) => String(line))
    .filter(line => line.includes('"kilo_internal_auth"'))
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('the invalidation route contract', () => {
  it('names the session-ingest audience and the invalidation scope', () => {
    expect(SESSION_INGEST_STS_AUDIENCE).toBe('session-ingest');
    expect(SESSION_ACCESS_INVALIDATE_SCOPE).toBe('session-ingest:session-access.invalidate');
  });

  it('reads an unset or empty mode as legacy-only and refuses a value outside the set', () => {
    expect(invalidateCredentialAcceptance(undefined)).toEqual({ legacy: true, sts: false });
    expect(invalidateCredentialAcceptance('')).toEqual({ legacy: true, sts: false });
    expect(invalidateCredentialAcceptance('sts')).toBeNull();
    expect(invalidateCredentialAcceptance('LEGACY-ONLY')).toBeNull();
  });
});

describe.each([undefined, '', 'legacy-only'])('mode %j (the default)', mode => {
  const vars = {
    SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT: mode,
    STS_ENVIRONMENT: 'production',
  };

  it('admits the shared secret, counted under its own route', async () => {
    const fetches = stubFetch();
    const log = vi.spyOn(console, 'log');
    const { env } = makeEnv(vars);
    const response = await call(env, { 'X-Internal-Secret': SECRET, 'x-kilo-caller': 'web' });
    expect(response.status).toBe(204);
    expect(invalidateOrganization).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(fetches).toEqual([]);
    expect(authLines(log)).toEqual([
      expect.objectContaining({
        receiver: 'session-ingest',
        route: 'cloud_agent_internal',
        auth: 'legacy_shared_secret',
        caller: 'web',
      }),
    ]);
  });

  it('refuses an STS token as before, with no key-set fetch', async () => {
    const fetches = stubFetch();
    const { env } = makeEnv(vars);
    const response = await call(env, { Authorization: `Bearer ${await token()}` });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, error: 'Unauthorized' });
    expect(invalidateOrganization).not.toHaveBeenCalled();
    expect(fetches).toEqual([]);
  });

  it('lets the shared secret decide when both credentials arrive, as before', async () => {
    const fetches = stubFetch();
    const { env } = makeEnv(vars);
    const response = await call(env, {
      Authorization: `Bearer ${await token()}`,
      'X-Internal-Secret': SECRET,
    });
    expect(response.status).toBe(204);
    expect(fetches).toEqual([]);
  });

  it('answers the metadata path with the ordinary 404', async () => {
    const fetches = stubFetch();
    const { env } = makeEnv(vars);
    const response = await app.request(METADATA_URL, {}, env);
    expect(response.status).toBe(404);
    expect(fetches).toEqual([]);
  });
});

describe('a mode outside the set, and disabled', () => {
  it('answers 500 for an unknown mode without reading the secret', async () => {
    stubFetch();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, reads } = makeEnv({ SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT: 'sts' });
    const response = await call(env, { 'X-Internal-Secret': SECRET });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'server_misconfigured' });
    expect(reads()).toBe(0);
    expect(invalidateOrganization).not.toHaveBeenCalled();
  });

  it('refuses both credentials when disabled', async () => {
    const fetches = stubFetch();
    const { env, reads } = makeEnv({
      SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT: 'disabled',
      STS_ENVIRONMENT: 'production',
    });
    const legacy = await call(env, { 'X-Internal-Secret': SECRET });
    const sts = await call(env, { Authorization: `Bearer ${await token()}` });
    expect([legacy.status, sts.status]).toEqual([401, 401]);
    expect(reads()).toBe(0);
    expect(fetches).toEqual([]);
    expect(invalidateOrganization).not.toHaveBeenCalled();
  });
});

describe.each(['legacy-and-sts', 'sts-only'])('mode %s', mode => {
  const vars = {
    SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT: mode,
    STS_ENVIRONMENT: 'production',
  };

  it('admits a web token without reading the secret and logs the sts admission', async () => {
    const fetches = stubFetch();
    const log = vi.spyOn(console, 'log');
    const { env, reads } = makeEnv(vars);
    const bearer = await token();
    // The unsigned caller header names someone else; the line names the verified workload.
    const response = await call(env, {
      Authorization: `Bearer ${bearer}`,
      'x-kilo-caller': 'ai-gateway',
    });
    expect(response.status).toBe(204);
    expect(invalidateOrganization).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(reads()).toBe(0);
    expect(fetches.every(url => url === JWKS_URL)).toBe(true);
    expect(authLines(log)).toEqual([
      {
        event: 'kilo_internal_auth',
        v: 1,
        receiver: 'session-ingest',
        route: 'cloud_agent_internal',
        auth: 'sts',
        caller: 'web',
        count: 1,
        minute: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(bearer);
  });

  it.each<[string, () => Promise<string>, number, string]>([
    [
      'another audience',
      () => token({ aud: 'web', scope: 'web:sts.canary' }),
      403,
      'insufficient_scope',
    ],
    [
      'another session-ingest scope',
      () => token({ scope: 'session-ingest:sessions.read' }),
      403,
      'insufficient_scope',
    ],
    ['a workload other than web', () => token({}, 'cloud-agent-next'), 403, 'insufficient_scope'],
    ['another environment', () => token({ env: 'staging' }), 401, 'invalid_token'],
    ['another issuer', () => token({ iss: STS_ISSUERS.staging }), 401, 'invalid_token'],
    [
      'an expired token',
      () => {
        const past = Math.floor(Date.now() / 1000) - 3_600;
        return token({ iat: past, exp: past + 300 });
      },
      401,
      'invalid_token',
    ],
    [
      'a forged signature',
      async () => token({}, 'web', await testSigner(signer.kid)),
      401,
      'invalid_token',
    ],
    ['a malformed token', async () => 'not.a.token', 401, 'invalid_token'],
    ['the shared secret sent as a bearer', async () => SECRET, 401, 'invalid_token'],
  ])(
    'refuses %s and never retries it as the shared secret',
    async (_label, make, status, error) => {
      stubFetch();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log');
      const { env, reads } = makeEnv(vars);
      const bearer = await make();
      const response = await call(env, { Authorization: `Bearer ${bearer}` });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(reads()).toBe(0);
      expect(invalidateOrganization).not.toHaveBeenCalled();
      expect(authLines(log)).toEqual([]);
      const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
      expect(logged).toContain('session_access_invalidate_sts_refused');
      expect(logged).not.toContain(bearer);
    }
  );

  it('refuses a request that carries both credentials without reading the secret', async () => {
    stubFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, reads } = makeEnv(vars);
    const response = await call(env, {
      Authorization: `Bearer ${await token()}`,
      'X-Internal-Secret': SECRET,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(reads()).toBe(0);
    expect(invalidateOrganization).not.toHaveBeenCalled();
  });

  it('answers 503 with Retry-After while the STS key set is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 502 }))
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `development` gets its own verifier, so no key set held from another test serves it.
    const { env } = makeEnv({
      SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT: mode,
      STS_ENVIRONMENT: 'development',
    });
    const response = await call(env, {
      Authorization: `Bearer ${await token({ iss: STS_ISSUERS.development, env: 'development' })}`,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect(invalidateOrganization).not.toHaveBeenCalled();
  });

  it('answers 500 when STS_ENVIRONMENT is missing or has no deployment', async () => {
    stubFetch();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const environment of [undefined, 'prod', 'staging']) {
      const { env } = makeEnv({
        SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT: mode,
        STS_ENVIRONMENT: environment,
      });
      const response = await call(env, { Authorization: `Bearer ${await token()}` });
      expect(response.status).toBe(500);
    }
    expect(invalidateOrganization).not.toHaveBeenCalled();
  });

  it('serves the metadata the challenge names, from configuration only', async () => {
    const fetches = stubFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, reads } = makeEnv(vars);
    const metadata = await app.request(
      'https://attacker.example/.well-known/oauth-protected-resource',
      {},
      env
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      resource: 'https://ingest.kilosessions.ai',
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['session-ingest:session-access.invalidate'],
    });
    expect(reads()).toBe(0);
    expect(fetches).toEqual([]);
    const challenge = await call(env, { Authorization: 'Bearer x' });
    expect(challenge.headers.get('www-authenticate')).toContain(
      `resource_metadata="${METADATA_URL}"`
    );
  });

  it('leaves the other internal routes on the shared secret', async () => {
    stubFetch();
    const { env } = makeEnv(vars);
    const response = await app.request(
      '/internal/session/ses_12345678901234567890123456/export',
      { headers: { Authorization: `Bearer ${await token()}`, 'X-Kilo-User-Id': 'usr_1' } },
      env
    );
    expect(response.status).toBe(401);
  });
});

describe('legacy-and-sts', () => {
  it('runs the shared-secret check for a request without Authorization', async () => {
    const fetches = stubFetch();
    const log = vi.spyOn(console, 'log');
    const { env, reads } = makeEnv({
      SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT: 'legacy-and-sts',
      STS_ENVIRONMENT: 'production',
    });
    const response = await call(env, { 'X-Internal-Secret': SECRET });
    expect(response.status).toBe(204);
    expect(reads()).toBe(1);
    expect(fetches).toEqual([]);
    expect(authLines(log)).toEqual([
      expect.objectContaining({
        route: 'cloud_agent_internal',
        auth: 'legacy_shared_secret',
      }),
    ]);
  });
});

describe('sts-only', () => {
  it('refuses the shared secret without reading it, with the STS challenge', async () => {
    stubFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, reads } = makeEnv({
      SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT: 'sts-only',
      STS_ENVIRONMENT: 'production',
    });
    const response = await call(env, { 'X-Internal-Secret': SECRET });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA_URL}"`
    );
    expect(reads()).toBe(0);
    expect(invalidateOrganization).not.toHaveBeenCalled();
  });
});
