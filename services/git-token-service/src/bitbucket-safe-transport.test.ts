import { describe, expect, it } from 'vitest';
import { listBitbucketWorkspaceRepositories } from './bitbucket-api.js';
import { fetchBitbucket, readBoundedBitbucketBody } from './bitbucket-safe-transport.js';
import {
  listBitbucketRepositories,
  type BitbucketRuntimeTokenResolverDependencies,
} from './bitbucket-runtime-token-resolver.js';

const token = 'private-token-fixture';
const workspaceUuid = 'a07d5c40-2d2d-4e79-a812-6a47824a77d6';
const repositoryUuid = '38a47a32-cb87-4a9f-b75d-7224774bba77';
const endpoint = 'https://api.bitbucket.org/2.0/repositories/acme?pagelen=50';
const json = (value: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const list = (fetch: typeof globalThis.fetch, requestTimeoutMs?: number) =>
  listBitbucketWorkspaceRepositories({
    accessToken: token,
    workspace: { slug: 'acme', uuid: workspaceUuid },
    fetch,
    requestTimeoutMs,
  });
const repositoryPayload = {
  uuid: `{${repositoryUuid}}`,
  name: 'Widgets',
  slug: 'widgets',
  full_name: 'acme/widgets',
  is_private: true,
  workspace: { uuid: `{${workspaceUuid}}`, slug: 'acme' },
  mainbranch: { name: 'trunk' },
};

describe('legacy repository caller through the shared transport', () => {
  it('preserves credential invalidation and uses the next authorized token', async () => {
    let generation = 1;
    const invalidations: unknown[] = [];
    const dependencies: BitbucketRuntimeTokenResolverDependencies = {
      authorizationService: {
        getAuthorization: async () => ({
          status: 'available',
          token: `${token}-${generation}`,
          organizationId: 'org',
          integrationId: 'integration',
          credentialId: 'credential',
          credentialVersion: generation,
          providerScopes: ['repository'],
          workspace: { uuid: workspaceUuid, slug: 'acme' },
        }),
        invalidateAuthorization: async (authorization, reason) => {
          invalidations.push({
            credentialId: authorization.credentialId,
            version: authorization.credentialVersion,
            reason,
          });
        },
      },
      oauthAuthorizationService: { getAuthorization: async () => ({ status: 'not_connected' }) },
      findCachedRepository: async () => ({ status: 'repository_not_found' }),
      listRepositories: options =>
        listBitbucketWorkspaceRepositories({
          ...options,
          fetch: async (_url, init) =>
            new Headers(init?.headers).get('authorization') === `Bearer ${token}-2`
              ? json({ pagelen: 50, values: [repositoryPayload] })
              : json({}, 401),
        }),
    };
    const owner = { userId: 'user', orgId: 'org' };
    await expect(
      listBitbucketRepositories({} as CloudflareEnv, owner, dependencies)
    ).resolves.toEqual({ status: 'reconnect_required' });
    expect(invalidations).toEqual([
      { credentialId: 'credential', version: 1, reason: 'provider_rejected' },
    ]);
    generation = 2;
    await expect(
      listBitbucketRepositories({} as CloudflareEnv, owner, dependencies)
    ).resolves.toMatchObject({ status: 'available', repositories: [{ id: repositoryUuid }] });
  });

  it('retains normalized legacy output and the authorized request', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const result = await list(async (url, init) => {
      requests.push({ url: url instanceof Request ? url.url : url.toString(), init });
      return json({ pagelen: 50, values: [repositoryPayload] });
    });
    expect(result).toEqual([
      {
        id: repositoryUuid,
        workspaceUuid,
        name: 'Widgets',
        fullName: 'acme/widgets',
        private: true,
        defaultBranch: 'trunk',
      },
    ]);
    expect(requests).toEqual([
      {
        url: endpoint,
        init: {
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          redirect: 'manual',
          signal: expect.any(AbortSignal),
        },
      },
    ]);
  });

  it('retains the legacy empty collection', async () => {
    await expect(list(async () => json({ pagelen: 50, values: [] }))).resolves.toEqual([]);
  });

  it.each([
    [201, 'request_failed'],
    [202, 'request_failed'],
    [204, 'request_failed'],
    [401, 'authentication_rejected'],
    [403, 'insufficient_permissions'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [503, 'provider_unavailable'],
  ] as const)('keeps legacy status %s classified as %s', async (status, code) => {
    await expect(
      list(async () =>
        status === 204 ? new Response(null, { status }) : json({ pagelen: 50, values: [] }, status)
      )
    ).rejects.toMatchObject({ code });
  });

  it.each([
    { pagelen: 51, values: [] },
    { pagelen: 50, values: 'invalid' },
    { pagelen: 50, values: [{ ...repositoryPayload, uuid: 'invalid' }] },
  ])('keeps repository schema rejection %#', async payload => {
    await expect(list(async () => json(payload))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('keeps workspace mismatch distinct from malformed data', async () => {
    await expect(
      list(async () =>
        json({ pagelen: 50, values: [{ ...repositoryPayload, full_name: 'other/widgets' }] })
      )
    ).rejects.toMatchObject({ code: 'workspace_mismatch' });
  });

  it.each(['text/plain', 'text/html'])(
    'keeps the legacy JSON media requirement for %s',
    async type => {
      await expect(
        list(async () => json({ pagelen: 50, values: [] }, 200, { 'content-type': type }))
      ).rejects.toMatchObject({ code: 'invalid_response' });
    }
  );

  it('keeps JSON decoding failures redacted', async () => {
    await expect(
      list(async () => new Response(token, { headers: { 'content-type': 'application/json' } }))
    ).rejects.toMatchObject({ code: 'invalid_response', message: 'invalid_response' });
  });

  it.each([
    'https://evil.example/2.0/repositories/acme?pagelen=50',
    'https://api.bitbucket.org/2.0/repositories/other?pagelen=50',
    `${endpoint}&role=contributor`,
    endpoint,
  ])('keeps legacy next-link rejection for %s', async next => {
    let requests = 0;
    await expect(
      list(async () => {
        requests += 1;
        return json({ pagelen: 50, values: [], next });
      })
    ).rejects.toMatchObject({ code: 'invalid_pagination' });
    expect(requests).toBe(1);
  });

  it('keeps the legacy page traversal bound', async () => {
    let page = 0;
    await expect(
      list(async () => json({ pagelen: 50, values: [], next: `${endpoint}&page=${++page + 1}` }))
    ).rejects.toMatchObject({ code: 'page_limit_exceeded' });
    expect(page).toBe(100);
  });
});

describe('bounded Bitbucket HTTP primitives', () => {
  it.each([
    'http://api.bitbucket.org/2.0/repositories/acme',
    'https://api.bitbucket.org.evil.example/2.0/repositories/acme',
    'https://api.bitbucket.org:443/2.0/repositories/acme',
    'https://user@api.bitbucket.org/2.0/repositories/acme',
    'https://api.bitbucket.org/2.0/repositories/other',
    'https://api.bitbucket.org/2.0/repositories/other/../acme',
  ])('rejects an unauthorized target before credentials leave: %s', async url => {
    let requests = 0;
    await expect(
      fetchBitbucket(url, {
        accessToken: token,
        resourcePath: '/2.0/repositories/acme',
        fetch: async () => {
          requests += 1;
          return json({});
        },
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(requests).toBe(0);
  });

  it.each([301, 302, 307, 308])('rejects redirect %s without a second request', async status => {
    let requests = 0;
    await expect(
      list(async () => {
        requests += 1;
        return new Response(null, { status, headers: { location: 'https://evil.example' } });
      })
    ).rejects.toMatchObject({ code: 'redirect_rejected' });
    expect(requests).toBe(1);
  });

  it.each([
    { redirected: true, url: endpoint },
    { redirected: false, url: 'https://evil.example' },
  ])('rejects response address mismatch %#', async metadata => {
    const response = json({ pagelen: 50, values: [] });
    Object.defineProperties(response, {
      redirected: { value: metadata.redirected },
      url: { value: metadata.url },
    });
    await expect(list(async () => response)).rejects.toMatchObject({ code: 'redirect_rejected' });
  });

  it.each(['declared', 'streamed'])('bounds %s response bytes', async kind => {
    const response = new Response(kind === 'streamed' ? 'x'.repeat(1_000_001) : '{}', {
      headers: {
        'content-type': 'application/json',
        'content-length': kind === 'declared' ? '1000001' : '2',
      },
    });
    await expect(list(async () => response)).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('retains the old request ceiling by default', async () => {
    let requests = 0;
    await expect(
      fetchBitbucket(endpoint, {
        accessToken: token,
        resourcePath: '/2.0/repositories/acme',
        method: 'POST',
        body: 'x'.repeat(16_001),
        fetch: async () => {
          requests += 1;
          return json({});
        },
      })
    ).rejects.toMatchObject({ code: 'request_too_large' });
    expect(requests).toBe(0);
  });

  it('times out the request without exposing transport credentials', async () => {
    await expect(
      list(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error(token)), { once: true });
          }),
        5
      )
    ).rejects.toMatchObject({ code: 'request_timed_out', message: 'request_timed_out' });
  });

  it('cancels a stalled body even when the stream ignores fetch cancellation', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      })
    );
    await expect(readBoundedBitbucketBody(response, AbortSignal.timeout(5))).rejects.toMatchObject({
      code: 'request_timed_out',
    });
    expect(cancelled).toBe(true);
  });

  it('drops transport causes and credential-bearing request objects', async () => {
    const result = await list(async () => {
      throw Object.assign(new Error(`Authorization: Bearer ${token}`), { request: { token } });
    }).catch(error => error);
    expect(result).toMatchObject({ code: 'transport_failed' });
    expect(`${JSON.stringify(result)} ${String(result)} ${result.stack}`).not.toContain(token);
    expect(result).not.toHaveProperty('cause');
    expect(result).not.toHaveProperty('request');
  });
});
