import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;
    ctx: ExecutionContext;
    constructor() {
      this.env = undefined;
      this.ctx = {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;
    }
  },
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
import { getWorkerDb } from '@kilocode/db/client';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { getSessionAccessCacheDO } from './dos/SessionAccessCacheDO';
import { getUserConnectionDO } from './dos/UserConnectionDO';
import { signSessionShareToken } from './services/session-share-token';
import { signKiloToken } from '@kilocode/worker-utils/kilo-token';
import { signSessionAccessInvalidationCredential } from '@kilocode/worker-utils/session-access-invalidation-credential';
import { SESSION_INGEST_INVALIDATION_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';

const INVALIDATION_SECRET = 'session-ingest-invalidation-signing-secret-for-tests';
const INVALIDATION_USER_ID = 'usr_removed';
const INVALIDATION_ORG_ID = '11111111-1111-4111-8111-111111111111';

type TestBindings = {
  INTERNAL_SESSION_AUTH_LEGACY_ENABLED?: string;
  HYPERDRIVE: { connectionString: string };
  SESSION_INGEST_DO: unknown;
  SESSION_ACCESS_CACHE_DO: unknown;
  NEXTAUTH_SECRET: unknown;
  NEXTAUTH_SECRET_RAW?: string;
  INTERNAL_API_SECRET_PROD: { get(): Promise<string> };
  SESSION_INGEST_INVALIDATION_SIGNING_SECRET_PROD: { get(): Promise<string> };
  SESSION_SHARE_JWT_SECRET_PROD: { get(): Promise<string> };
  SESSION_SHARE_TOKEN_MIN_IAT: string;
};

function makeDbFakes() {
  const selectResult = vi.fn<() => Promise<unknown[]>>(async () => []);
  const select = {
    from: vi.fn(() => select),
    leftJoin: vi.fn(() => select),
    where: vi.fn(() => select),
    limit: vi.fn(() => select),
    then: vi.fn((resolve: (v: unknown) => unknown) => resolve(selectResult())),
  };

  const db = {
    select: vi.fn(() => select),
  };

  return { db, selectResult };
}

const defaultEnv: TestBindings = {
  INTERNAL_SESSION_AUTH_LEGACY_ENABLED: 'false',
  HYPERDRIVE: { connectionString: 'postgres://test' },
  SESSION_INGEST_DO: {},
  SESSION_ACCESS_CACHE_DO: {},
  NEXTAUTH_SECRET: {},
  NEXTAUTH_SECRET_RAW: 'secret',
  INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
  SESSION_INGEST_INVALIDATION_SIGNING_SECRET_PROD: { get: async () => INVALIDATION_SECRET },
  SESSION_SHARE_JWT_SECRET_PROD: {
    get: async () => 'session-share-secret-for-tests-32-bytes',
  },
  SESSION_SHARE_TOKEN_MIN_IAT: '0',
};

function setInvalidationDos() {
  const cache = { invalidateOrganization: vi.fn(async () => undefined) };
  vi.mocked(getSessionAccessCacheDO).mockReturnValue(
    cache as unknown as ReturnType<typeof getSessionAccessCacheDO>
  );
  const closeViewerSockets = vi.fn(async () => 0);
  vi.mocked(getUserConnectionDO).mockReturnValue({
    closeViewerSockets,
  } as unknown as ReturnType<typeof getUserConnectionDO>);
  return { cache, closeViewerSockets };
}

function invalidationRequest(
  options: {
    token?: string;
    headers?: Record<string, string>;
    body?: unknown;
    env?: TestBindings;
  } = {}
) {
  return app.request(
    '/internal/session-access/invalidate',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      body: JSON.stringify(
        options.body ?? {
          kiloUserId: INVALIDATION_USER_ID,
          organizationId: INVALIDATION_ORG_ID,
        }
      ),
    },
    options.env ?? defaultEnv
  );
}

async function signedInvalidationToken(
  overrides: {
    userId?: string;
    organizationId?: string;
    audience?: string;
    expiresInSeconds?: number;
  } = {}
): Promise<string> {
  const { token } = await signKiloToken({
    userId: overrides.userId ?? INVALIDATION_USER_ID,
    secret: INVALIDATION_SECRET,
    expiresInSeconds: overrides.expiresInSeconds ?? 60,
    audience: overrides.audience ?? SESSION_INGEST_INVALIDATION_AUDIENCE,
    extra: { organizationId: overrides.organizationId ?? INVALIDATION_ORG_ID },
  });
  return token;
}

describe('session access invalidation route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects the general internal secret when compatibility is disabled', async () => {
    const { cache, closeViewerSockets } = setInvalidationDos();

    const res = await invalidationRequest({
      headers: {
        'X-Internal-Secret': 'internal-secret',
        'X-Kilo-User-Id': INVALIDATION_USER_ID,
      },
    });

    expect(res.status).toBe(401);
    expect(getSessionAccessCacheDO).not.toHaveBeenCalled();
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
    expect(getUserConnectionDO).not.toHaveBeenCalled();
    expect(closeViewerSockets).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'true'])(
    'accepts legacy callers while compatibility is %s',
    async value => {
      const { cache, closeViewerSockets } = setInvalidationDos();
      const res = await invalidationRequest({
        headers: { 'X-Internal-Secret': 'internal-secret' },
        env: {
          ...defaultEnv,
          INTERNAL_SESSION_AUTH_LEGACY_ENABLED: value,
          SESSION_INGEST_INVALIDATION_SIGNING_SECRET_PROD: { get: async () => '' },
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(cache.invalidateOrganization).toHaveBeenCalledWith(INVALIDATION_ORG_ID);
      expect(closeViewerSockets).toHaveBeenCalled();
    }
  );

  it.each(['false', 'FALSE', 'invalid'])('rejects legacy auth with flag %s', async value => {
    const { cache } = setInvalidationDos();
    const res = await invalidationRequest({
      headers: { 'X-Internal-Secret': 'internal-secret' },
      env: { ...defaultEnv, INTERNAL_SESSION_AUTH_LEGACY_ENABLED: value },
    });
    expect(res.status).toBe(401);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
  });

  it('rejects an incorrect legacy secret during compatibility', async () => {
    const { cache } = setInvalidationDos();
    const res = await invalidationRequest({
      headers: { 'X-Internal-Secret': 'incorrect-secret' },
      env: { ...defaultEnv, INTERNAL_SESSION_AUTH_LEGACY_ENABLED: 'true' },
    });
    expect(res.status).toBe(401);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
  });

  it.each<{ headers: Record<string, string>; authMethod: 'legacy' | 'bearer' }>([
    { headers: {}, authMethod: 'legacy' },
    { headers: { 'X-Internal-Secret': 'incorrect-secret' }, authMethod: 'legacy' },
    {
      headers: { authorization: 'Bearer not-a-jwt', 'X-Internal-Secret': 'internal-secret' },
      authMethod: 'bearer',
    },
  ])('audits rejected $authMethod authentication', async ({ headers, authMethod }) => {
    const audit = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const res = await invalidationRequest({
        headers,
        env: { ...defaultEnv, INTERNAL_SESSION_AUTH_LEGACY_ENABLED: 'true' },
      });

      expect(res.status).toBe(401);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(JSON.parse(audit.mock.calls[0][0])).toMatchObject({
        type: 'session_access_invalidation',
        outcome: 'unauthorized',
        status: 401,
        authMethod,
      });
    } finally {
      audit.mockRestore();
    }
  });

  it.each(['', 'Basic malformed', 'Bearer ', 'Bearer not-a-jwt'])(
    'does not replace Authorization %j with a valid legacy credential',
    async authorization => {
      const { cache } = setInvalidationDos();
      const res = await invalidationRequest({
        headers: { authorization, 'X-Internal-Secret': 'internal-secret' },
        env: { ...defaultEnv, INTERNAL_SESSION_AUTH_LEGACY_ENABLED: 'true' },
      });
      expect(res.status).toBe(401);
      expect(cache.invalidateOrganization).not.toHaveBeenCalled();
    }
  );

  it.each([
    { claims: { expiresInSeconds: -1 }, status: 401 },
    { claims: { audience: 'another-service' }, status: 401 },
    { claims: { userId: 'another-user' }, status: 403 },
    { claims: { organizationId: '22222222-2222-4222-8222-222222222222' }, status: 403 },
  ])('preserves bearer checks with a legacy header: %j', async ({ claims, status }) => {
    const { cache } = setInvalidationDos();
    const res = await invalidationRequest({
      token: await signedInvalidationToken(claims),
      headers: { 'X-Internal-Secret': 'internal-secret' },
      env: { ...defaultEnv, INTERNAL_SESSION_AUTH_LEGACY_ENABLED: 'true' },
    });
    expect(res.status).toBe(status);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
  });

  it('uses the bearer when both credentials are present', async () => {
    const { cache } = setInvalidationDos();
    const audit = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const res = await invalidationRequest({
        token: await signedInvalidationToken(),
        headers: { 'X-Internal-Secret': 'incorrect-secret' },
        env: { ...defaultEnv, INTERNAL_SESSION_AUTH_LEGACY_ENABLED: 'true' },
      });
      expect(res.status).toBe(204);
      expect(cache.invalidateOrganization).toHaveBeenCalledWith(INVALIDATION_ORG_ID);
      expect(audit).toHaveBeenCalledWith(expect.stringContaining('"authMethod":"bearer"'));
    } finally {
      audit.mockRestore();
    }
  });

  it('returns a retryable failure when the legacy secret store is unavailable', async () => {
    const { cache } = setInvalidationDos();
    const res = await invalidationRequest({
      headers: { 'X-Internal-Secret': 'internal-secret' },
      env: {
        ...defaultEnv,
        INTERNAL_SESSION_AUTH_LEGACY_ENABLED: 'true',
        INTERNAL_API_SECRET_PROD: {
          get: async () => {
            throw new Error('unavailable');
          },
        },
      },
    });
    expect(res.status).toBe(503);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
  });

  it('rejects a credential signed with the general internal secret', async () => {
    const { cache, closeViewerSockets } = setInvalidationDos();
    const { token } = await signKiloToken({
      userId: INVALIDATION_USER_ID,
      secret: 'internal-secret',
      expiresInSeconds: 60,
      audience: SESSION_INGEST_INVALIDATION_AUDIENCE,
      extra: { organizationId: INVALIDATION_ORG_ID },
    });

    const res = await invalidationRequest({ token });

    expect(res.status).toBe(401);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
    expect(getUserConnectionDO).not.toHaveBeenCalled();
    expect(closeViewerSockets).not.toHaveBeenCalled();
  });

  it('rejects invalidation without a credential', async () => {
    const { cache, closeViewerSockets } = setInvalidationDos();

    const res = await invalidationRequest();

    expect(res.status).toBe(401);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
    expect(getUserConnectionDO).not.toHaveBeenCalled();
    expect(closeViewerSockets).not.toHaveBeenCalled();
  });

  it('rejects a malformed credential', async () => {
    const { cache, closeViewerSockets } = setInvalidationDos();

    const res = await invalidationRequest({ token: 'not-a-jwt' });

    expect(res.status).toBe(401);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
    expect(getUserConnectionDO).not.toHaveBeenCalled();
    expect(closeViewerSockets).not.toHaveBeenCalled();
  });

  it('rejects an invalid credential without reading the request body', async () => {
    const { cache, closeViewerSockets } = setInvalidationDos();
    const request = new Request('http://localhost/internal/session-access/invalidate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer not-a-jwt',
      },
      body: JSON.stringify({
        kiloUserId: INVALIDATION_USER_ID,
        organizationId: INVALIDATION_ORG_ID,
      }),
    });
    let bodyReads = 0;
    const readBody = request.text.bind(request);
    Object.defineProperty(request, 'text', {
      value: async () => {
        bodyReads += 1;
        return readBody();
      },
    });

    const res = await app.request(request, undefined, defaultEnv);

    expect(res.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(bodyReads).toBe(0);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
    expect(getUserConnectionDO).not.toHaveBeenCalled();
    expect(closeViewerSockets).not.toHaveBeenCalled();
  });

  it('rejects an expired credential', async () => {
    const { cache, closeViewerSockets } = setInvalidationDos();
    const token = await signedInvalidationToken({ expiresInSeconds: -10 });

    const res = await invalidationRequest({ token });

    expect(res.status).toBe(401);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
    expect(getUserConnectionDO).not.toHaveBeenCalled();
    expect(closeViewerSockets).not.toHaveBeenCalled();
  });

  it('rejects a credential for another audience', async () => {
    const { cache, closeViewerSockets } = setInvalidationDos();
    const token = await signedInvalidationToken({ audience: 'another-service' });

    const res = await invalidationRequest({ token });

    expect(res.status).toBe(401);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
    expect(getUserConnectionDO).not.toHaveBeenCalled();
    expect(closeViewerSockets).not.toHaveBeenCalled();
  });

  it('rejects a credential whose subject is a different user', async () => {
    const { cache, closeViewerSockets } = setInvalidationDos();
    const token = await signedInvalidationToken({ userId: 'usr_other' });

    const res = await invalidationRequest({ token });

    expect(res.status).toBe(403);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
    expect(getUserConnectionDO).not.toHaveBeenCalled();
    expect(closeViewerSockets).not.toHaveBeenCalled();
  });

  it('rejects a credential bound to a different organization', async () => {
    const { cache, closeViewerSockets } = setInvalidationDos();
    const token = await signedInvalidationToken({
      organizationId: '22222222-2222-4222-8222-222222222222',
    });

    const res = await invalidationRequest({ token });

    expect(res.status).toBe(403);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
    expect(getUserConnectionDO).not.toHaveBeenCalled();
    expect(closeViewerSockets).not.toHaveBeenCalled();
  });

  it('invalidates cached access and closes viewer sockets for the intended sender', async () => {
    const { cache, closeViewerSockets } = setInvalidationDos();
    const token = await signSessionAccessInvalidationCredential({
      userId: INVALIDATION_USER_ID,
      organizationId: INVALIDATION_ORG_ID,
      secret: INVALIDATION_SECRET,
    });

    const res = await invalidationRequest({ token });

    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(getSessionAccessCacheDO).toHaveBeenCalledWith(defaultEnv, {
      kiloUserId: INVALIDATION_USER_ID,
    });
    expect(cache.invalidateOrganization).toHaveBeenCalledWith(INVALIDATION_ORG_ID);
    expect(getUserConnectionDO).toHaveBeenCalledWith(defaultEnv, {
      kiloUserId: INVALIDATION_USER_ID,
    });
    expect(closeViewerSockets).toHaveBeenCalled();
  });

  it('returns 503 when the dedicated secret cannot be resolved', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { cache } = setInvalidationDos();

    const res = await app.request(
      '/internal/session-access/invalidate',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer caller-supplied-token',
        },
        body: JSON.stringify({
          kiloUserId: INVALIDATION_USER_ID,
          organizationId: INVALIDATION_ORG_ID,
        }),
      },
      {
        ...defaultEnv,
        SESSION_INGEST_INVALIDATION_SIGNING_SECRET_PROD: {
          get: async () => {
            throw new Error('secret store unavailable');
          },
        },
      }
    );

    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body).toEqual({ success: false, error: 'Service temporarily unavailable' });
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
    expect(getUserConnectionDO).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('secret store unavailable');
    expect(JSON.stringify(error.mock.calls)).not.toContain('caller-supplied-token');
    error.mockRestore();
  });

  it('returns 503 when the dedicated secret is not configured', async () => {
    const { cache } = setInvalidationDos();

    const res = await app.request(
      '/internal/session-access/invalidate',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer caller-supplied-token',
        },
        body: JSON.stringify({
          kiloUserId: INVALIDATION_USER_ID,
          organizationId: INVALIDATION_ORG_ID,
        }),
      },
      {
        ...defaultEnv,
        SESSION_INGEST_INVALIDATION_SIGNING_SECRET_PROD: { get: async () => '' },
      }
    );

    expect(res.status).toBe(503);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
    expect(getUserConnectionDO).not.toHaveBeenCalled();
  });
});

describe('removed internal export route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('denies the removed export route even with the general secret and target headers', async () => {
    const res = await app.request(
      '/internal/session/ses_12345678901234567890123456/export',
      {
        method: 'GET',
        headers: {
          'X-Internal-Secret': 'internal-secret',
          'X-Kilo-User-Id': INVALIDATION_USER_ID,
        },
      },
      defaultEnv
    );

    expect(res.status).toBe(404);
    expect(getSessionIngestDO).not.toHaveBeenCalled();
  });
});

describe('public session route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 404 for malformed share tokens', async () => {
    const res = await app.request('/session/not-a-jwt', {}, defaultEnv);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the token generation is not found', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    selectResult.mockResolvedValueOnce([]);
    const token = await signSessionShareToken(defaultEnv, {
      sessionId: 'ses_12345678901234567890123456',
      publicId: '11111111-1111-4111-8111-111111111111',
    });

    const res = await app.request(`/session/${encodeURIComponent(token)}`, {}, defaultEnv);

    expect(res.status).toBe(404);
  });

  it('returns a matching DO snapshot with no-store caching', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const token = await signSessionShareToken(defaultEnv, {
      sessionId: 'ses_12345678901234567890123456',
      publicId: '11111111-1111-4111-8111-111111111111',
    });
    selectResult.mockResolvedValueOnce([
      {
        sessionId: 'ses_12345678901234567890123456',
        kiloUserId: 'usr_123',
        title: 'Shared title',
        ownerName: 'Shared owner',
      },
    ]);

    const stub = {
      getAllStream: vi.fn(async () => new Response('{"ok":true}').body!),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      stub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const res = await app.request(`/session/${encodeURIComponent(token)}`, {}, defaultEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('serializes created_at as UTC ISO at the HTTP boundary', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const token = await signSessionShareToken(defaultEnv, {
      sessionId: 'ses_12345678901234567890123456',
      publicId: '11111111-1111-4111-8111-111111111111',
    });
    selectResult.mockResolvedValueOnce([
      {
        sessionId: 'ses_12345678901234567890123456',
        kiloUserId: 'usr_123',
        title: 'Shared title',
        ownerName: 'Shared owner',
        gitUrl: 'https://github.com/owner/repo',
        gitBranch: 'main',
        createdAt: '2026-08-19 19:28:42.33099+00',
      },
    ]);

    const res = await app.request(`/session/${encodeURIComponent(token)}/metadata`, {}, defaultEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      title: 'Shared title',
      owner_name: 'Shared owner',
      git_url: 'https://github.com/owner/repo',
      git_branch: 'main',
      created_at: '2026-08-19T19:28:42.330Z',
    });
  });

  it('returns shared metadata with no-store caching', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const token = await signSessionShareToken(defaultEnv, {
      sessionId: 'ses_12345678901234567890123456',
      publicId: '11111111-1111-4111-8111-111111111111',
    });
    selectResult.mockResolvedValueOnce([
      {
        sessionId: 'ses_12345678901234567890123456',
        kiloUserId: 'usr_123',
        title: 'Shared title',
        ownerName: 'Shared owner',
        gitUrl: 'https://github.com/owner/repo',
        gitBranch: 'main',
        createdAt: '2026-08-19T10:00:00.000Z',
      },
    ]);

    const res = await app.request(`/session/${encodeURIComponent(token)}/metadata`, {}, defaultEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      success: true,
      title: 'Shared title',
      owner_name: 'Shared owner',
      git_url: 'https://github.com/owner/repo',
      git_branch: 'main',
      created_at: '2026-08-19T10:00:00.000Z',
    });
    expect(getSessionIngestDO).not.toHaveBeenCalled();
  });
});
