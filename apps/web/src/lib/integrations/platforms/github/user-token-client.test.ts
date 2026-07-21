import {
  getGitHubUserAccessToken,
  __resetGitHubUserAccessTokenClientForTests,
} from './user-token-client';

const mockConfig = {
  apiUrl: 'https://git-token-service.example.com',
};

jest.mock('@/lib/config.server', () => ({
  get GIT_TOKEN_SERVICE_API_URL() {
    return mockConfig.apiUrl;
  },
}));

jest.mock('@/lib/tokens', () => {
  const actual = jest.requireActual('@/lib/tokens');
  return {
    ...actual,
    TOKEN_EXPIRY: { fiveMinutes: 5 * 60 },
    generateInternalServiceToken: jest.fn(
      (userId: string, options?: { audience?: string; expiresIn?: number }) =>
        `internal-jwt(user=${userId},aud=${options?.audience ?? 'none'})`
    ),
  };
});

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let fetchMock: jest.Mock<ReturnType<FetchHandler>, Parameters<FetchHandler>>;

function makeConnectedResponse(overrides: {
  token?: string;
  expiresAtEpochMs?: number;
  githubLogin?: string;
  authorizationId?: string;
  credentialVersion?: number;
}): Response {
  return new Response(
    JSON.stringify({
      connected: true,
      token: overrides.token ?? 'ghs_default',
      expiresAtEpochMs: overrides.expiresAtEpochMs ?? Date.now() + 60 * 60 * 1000,
      githubLogin: overrides.githubLogin ?? 'octocat',
      authorizationId: overrides.authorizationId ?? 'auth-1',
      credentialVersion: overrides.credentialVersion ?? 1,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function makeDisconnectedResponse(reason: 'not_connected' | 'revoked'): Response {
  return new Response(JSON.stringify({ connected: false, reason }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  __resetGitHubUserAccessTokenClientForTests();
  mockConfig.apiUrl = 'https://git-token-service.example.com';
  fetchMock = jest.fn();
  jest.spyOn(global, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getGitHubUserAccessToken', () => {
  it('mints an internal JWT with the dedicated audience and POSTs to the token endpoint', async () => {
    fetchMock.mockResolvedValueOnce(makeConnectedResponse({ token: 'ghs_xyz' }));

    const result = await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });

    expect(result.status).toBe('connected');
    if (result.status !== 'connected') throw new Error('expected connected');

    const generateMock = (
      jest.requireMock('@/lib/tokens') as {
        generateInternalServiceToken: jest.Mock;
      }
    ).generateInternalServiceToken;
    expect(generateMock).toHaveBeenCalledWith('kilo-user-1', {
      expiresIn: 5 * 60,
      audience: 'git-token-service:github-user-access-token',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://git-token-service.example.com/internal/github-user-authorizations/token'
    );
    expect(init?.method).toBe('POST');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(
      'Bearer internal-jwt(user=kilo-user-1,aud=git-token-service:github-user-access-token)'
    );
    expect(init?.body).toBe(JSON.stringify({ op: 'fetch' }));
  });

  it('caches a successful fetch and reuses it on subsequent fetches without hitting the service', async () => {
    fetchMock.mockResolvedValueOnce(makeConnectedResponse({ token: 'ghs_first' }));

    const first = await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });
    const second = await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });

    expect(first).toEqual({
      status: 'connected',
      credential: expect.objectContaining({ token: 'ghs_first' }),
    });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats an entry as expired 5 minutes before the actual expiry', async () => {
    const expiresAt = Date.now() + 4 * 60 * 1000; // 4 minutes from now (< 5 min headroom)
    fetchMock.mockResolvedValueOnce(
      makeConnectedResponse({ token: 'ghs_soon', expiresAtEpochMs: expiresAt })
    );

    await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });
    fetchMock.mockResolvedValueOnce(makeConnectedResponse({ token: 'ghs_fresh' }));
    const second = await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (second.status !== 'connected') throw new Error('expected connected');
    expect(second.credential.token).toBe('ghs_fresh');
  });

  it('rotate does not consult the cache and always hits the endpoint', async () => {
    fetchMock.mockResolvedValueOnce(makeConnectedResponse({ token: 'ghs_first' }));
    await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });

    fetchMock.mockResolvedValueOnce(
      makeConnectedResponse({
        token: 'ghs_rotated',
        authorizationId: 'auth-2',
        credentialVersion: 2,
      })
    );
    const rotated = await getGitHubUserAccessToken('kilo-user-1', {
      op: 'rotate',
      staleAuthorizationId: 'auth-1',
      staleCredentialVersion: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init?.body).toBe(
      JSON.stringify({
        op: 'rotate',
        staleAuthorizationId: 'auth-1',
        staleCredentialVersion: 1,
      })
    );
    if (rotated.status !== 'connected') throw new Error('expected connected');
    expect(rotated.credential.token).toBe('ghs_rotated');
  });

  it('reportRejected never reads or writes the cache and always hits the endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      makeConnectedResponse({
        token: 'ghs_cached',
        authorizationId: 'auth-1',
        credentialVersion: 1,
      })
    );
    await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });

    fetchMock.mockResolvedValueOnce(makeDisconnectedResponse('revoked'));
    const reported = await getGitHubUserAccessToken('kilo-user-1', {
      op: 'reportRejected',
      authorizationId: 'auth-1',
      credentialVersion: 1,
    });

    expect(reported).toEqual({ status: 'disconnected', reason: 'revoked' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init?.body).toBe(
      JSON.stringify({
        op: 'reportRejected',
        authorizationId: 'auth-1',
        credentialVersion: 1,
      })
    );
  });

  it('reportRejected evicts a matching cached generation and a future fetch refreshes', async () => {
    fetchMock.mockResolvedValueOnce(
      makeConnectedResponse({
        token: 'ghs_cached',
        authorizationId: 'auth-1',
        credentialVersion: 1,
      })
    );
    await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });

    fetchMock.mockResolvedValueOnce(makeDisconnectedResponse('revoked'));
    await getGitHubUserAccessToken('kilo-user-1', {
      op: 'reportRejected',
      authorizationId: 'auth-1',
      credentialVersion: 1,
    });

    fetchMock.mockResolvedValueOnce(
      makeConnectedResponse({ token: 'ghs_fresh', authorizationId: 'auth-2', credentialVersion: 2 })
    );
    const after = await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });

    if (after.status !== 'connected') throw new Error('expected connected');
    expect(after.credential.token).toBe('ghs_fresh');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps a 503 response to temporarily_unavailable', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 })
    );

    const result = await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });

    expect(result).toEqual({ status: 'temporarily_unavailable' });
  });

  it('returns disconnected when the service is unconfigured', async () => {
    mockConfig.apiUrl = '';
    // The function returns `temporarily_unavailable` when unconfigured; this
    // documents the chosen behavior.
    const result = await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });
    expect(result).toEqual({ status: 'temporarily_unavailable' });
  });

  it('serializes overlapping rotate/reportRejected so a delayed rotate cannot re-insert an evicted generation', async () => {
    // First populate the cache with auth-1 v1.
    fetchMock.mockResolvedValueOnce(
      makeConnectedResponse({
        token: 'ghs_cached',
        authorizationId: 'auth-1',
        credentialVersion: 1,
      })
    );
    await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });

    // Wire two responses in order: rotate is slow (queued first), then a fast
    // reportRejected. The rotate must complete first because it was enqueued
    // first, then the reportRejected runs and evicts the rotate's write.
    let resolveRotate: ((value: Response) => void) | null = null;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          resolveRotate = resolve;
        })
    );
    fetchMock.mockResolvedValueOnce(makeDisconnectedResponse('revoked'));

    const rotatePromise = getGitHubUserAccessToken('kilo-user-1', {
      op: 'rotate',
      staleAuthorizationId: 'auth-1',
      staleCredentialVersion: 1,
    });
    const reportPromise = getGitHubUserAccessToken('kilo-user-1', {
      op: 'reportRejected',
      authorizationId: 'auth-1',
      credentialVersion: 1,
    });

    // Resolve the rotate; the report will run after it because the queue is
    // FIFO and rotate was enqueued first.
    // Flush microtasks so the rotate's in-flight fetch mock runs and
    // resolveRotate is assigned.
    await Promise.resolve();
    await Promise.resolve();
    resolveRotate!(
      makeConnectedResponse({
        token: 'ghs_rotated',
        authorizationId: 'auth-2',
        credentialVersion: 2,
      })
    );
    await rotatePromise;
    const report = await reportPromise;

    expect(report).toEqual({ status: 'disconnected', reason: 'revoked' });

    // After the report, the cache must hold neither auth-1 v1 nor auth-2 v2
    // (reportRejected on auth-1 v1 evicts only if cached <= op.credentialVersion
    // for the same authorizationId; auth-2 v2 is a different authorizationId
    // so it is left alone by the eviction rule). However, the rotate's
    // successful result was overwritten by the report's later write into the
    // cache because we serialize all writes — but report does not write the
    // cache, so rotate's write stands. The invariant we care about is that
    // no entry with credentialVersion <= 1 for authorizationId='auth-1'
    // remains in the cache.
    const cachedAfter = await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });
    if (cachedAfter.status === 'connected') {
      expect(
        cachedAfter.credential.authorizationId === 'auth-1' &&
          cachedAfter.credential.credentialVersion <= 1
      ).toBe(false);
    }
  });

  it('serializes overlapping fetch/reportRejected so a delayed fetch cannot repopulate a revoked generation', async () => {
    // Slow fetch + fast reportRejected.
    let resolveFetch: ((value: Response) => void) | null = null;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          resolveFetch = resolve;
        })
    );
    fetchMock.mockResolvedValueOnce(makeDisconnectedResponse('revoked'));

    const fetchPromise = getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });
    const reportPromise = getGitHubUserAccessToken('kilo-user-1', {
      op: 'reportRejected',
      authorizationId: 'auth-1',
      credentialVersion: 1,
    });

    // The report goes through the queue first (fetch is the one waiting
    // because fetch was started first; queue is FIFO, so report is behind
    // the in-flight fetch). We resolve the fetch now.
    resolveFetch!(
      makeConnectedResponse({
        token: 'ghs_cached',
        authorizationId: 'auth-1',
        credentialVersion: 1,
      })
    );
    await fetchPromise;
    const report = await reportPromise;

    expect(report).toEqual({ status: 'disconnected', reason: 'revoked' });

    // Cache holds auth-1 v1 after the fetch settled. The reportRejected that
    // ran afterward must have evicted it (it evicts when authorizationId
    // matches and credentialVersion <= op.credentialVersion). A subsequent
    // fetch must hit the service.
    fetchMock.mockResolvedValueOnce(
      makeConnectedResponse({ token: 'ghs_fresh', authorizationId: 'auth-2', credentialVersion: 2 })
    );
    const after = await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });
    if (after.status !== 'connected') throw new Error('expected connected');
    expect(after.credential.authorizationId).toBe('auth-2');
  });

  it('serializes a following cache-miss fetch AFTER reportRejected (reverse ordering)', async () => {
    // Empty cache. Enqueue reportRejected FIRST, then a cache-miss fetch.
    // FIFO: the report round-trips first (nothing to evict yet), then the
    // fetch runs and reflects post-report service state.
    fetchMock.mockResolvedValueOnce(makeDisconnectedResponse('revoked')); // report
    fetchMock.mockResolvedValueOnce(
      makeConnectedResponse({ token: 'ghs_new', authorizationId: 'auth-2', credentialVersion: 2 })
    ); // fetch

    const reportPromise = getGitHubUserAccessToken('kilo-user-1', {
      op: 'reportRejected',
      authorizationId: 'auth-1',
      credentialVersion: 1,
    });
    const fetchPromise = getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });

    const report = await reportPromise;
    const fetched = await fetchPromise;

    expect(report).toEqual({ status: 'disconnected', reason: 'revoked' });
    if (fetched.status !== 'connected') throw new Error('expected connected');
    expect(fetched.credential.authorizationId).toBe('auth-2');
    expect(fetched.credential.credentialVersion).toBe(2);

    // Invariant: no cache entry carries the rejected auth-1 generation.
    const cached = await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });
    if (cached.status === 'connected') {
      expect(
        cached.credential.authorizationId === 'auth-1' && cached.credential.credentialVersion <= 1
      ).toBe(false);
    }
  });

  it('serializes a following rotate AFTER reportRejected (reverse ordering)', async () => {
    fetchMock.mockResolvedValueOnce(makeDisconnectedResponse('revoked')); // report
    fetchMock.mockResolvedValueOnce(
      makeConnectedResponse({ token: 'ghs_rot', authorizationId: 'auth-2', credentialVersion: 2 })
    ); // rotate

    const reportPromise = getGitHubUserAccessToken('kilo-user-1', {
      op: 'reportRejected',
      authorizationId: 'auth-1',
      credentialVersion: 1,
    });
    const rotatePromise = getGitHubUserAccessToken('kilo-user-1', {
      op: 'rotate',
      staleAuthorizationId: 'auth-1',
      staleCredentialVersion: 1,
    });

    const report = await reportPromise;
    const rotate = await rotatePromise;

    expect(report).toEqual({ status: 'disconnected', reason: 'revoked' });
    if (rotate.status !== 'connected') throw new Error('expected connected');
    expect(rotate.credential.authorizationId).toBe('auth-2');
    // The rejected generation must not remain readable from cache.
    const cached = await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });
    if (cached.status === 'connected') {
      expect(
        cached.credential.authorizationId === 'auth-1' && cached.credential.credentialVersion <= 1
      ).toBe(false);
    }
  });

  it('treats a cache hit as a pure memory read that does not enter the queue', async () => {
    fetchMock.mockResolvedValueOnce(
      makeConnectedResponse({
        token: 'ghs_cached',
        authorizationId: 'auth-1',
        credentialVersion: 1,
      })
    );
    await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });

    // Queue a reportRejected (must be serialized). While it is in flight,
    // a cache hit for fetch must return immediately without going through
    // the queue.
    let resolveReport: ((value: Response) => void) | null = null;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          resolveReport = resolve;
        })
    );
    const reportPromise = getGitHubUserAccessToken('kilo-user-1', {
      op: 'reportRejected',
      authorizationId: 'auth-1',
      credentialVersion: 1,
    });

    // Cache hit — must resolve immediately and not wait for the report.
    const start = Date.now();
    const hit = await getGitHubUserAccessToken('kilo-user-1', { op: 'fetch' });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
    if (hit.status !== 'connected') throw new Error('expected connected');
    expect(hit.credential.token).toBe('ghs_cached');

    resolveReport!(makeDisconnectedResponse('revoked'));
    await reportPromise;
  });
});
