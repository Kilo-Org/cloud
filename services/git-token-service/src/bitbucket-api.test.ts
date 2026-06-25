import { describe, expect, it, vi } from 'vitest';
import { listBitbucketWorkspaceRepositories } from './bitbucket-api.js';

const REPOSITORY_PAGE_LENGTH = 50;
const MAX_REPOSITORY_PAGES = 20;
const MAX_REPOSITORY_ITEMS = 500;
const MAX_RESPONSE_BYTES = 1_000_000;
const accessToken = 'bitbucket-access-token-fixture';
const workspaceUuid = 'a07d5c40-2d2d-4e79-a812-6a47824a77d6';
const repositoryUuid = '38a47a32-cb87-4a9f-b75d-7224774bba77';
const anotherRepositoryUuid = '671c0279-67a5-4d24-8b21-4d6acdfa04d3';

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

function repositoryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: `{${repositoryUuid}}`,
    name: 'Widgets',
    slug: 'widgets',
    full_name: 'acme/widgets',
    is_private: true,
    workspace: { uuid: `{${workspaceUuid}}`, slug: 'acme' },
    mainbranch: { name: 'main' },
    ...overrides,
  };
}

function numberedUuid(index: number): string {
  return `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`;
}

describe('listBitbucketWorkspaceRepositories', () => {
  it('lists normalized repositories from the selected workspace endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        pagelen: 50,
        values: [
          {
            uuid: `{${repositoryUuid.toUpperCase()}}`,
            name: 'Widgets',
            slug: 'widgets',
            full_name: 'acme/widgets',
            is_private: true,
            workspace: {
              uuid: `{${workspaceUuid.toUpperCase()}}`,
              slug: 'acme',
            },
            mainbranch: { name: 'main' },
          },
        ],
      })
    );

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: `{${workspaceUuid.toUpperCase()}}` },
        fetch: fetchMock,
      })
    ).resolves.toEqual([
      {
        id: repositoryUuid,
        workspaceUuid,
        name: 'Widgets',
        fullName: 'acme/widgets',
        private: true,
        defaultBranch: 'main',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.bitbucket.org/2.0/repositories/acme?pagelen=50',
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      }
    );
  });

  it.each([' token', 'token ', 'to ken', 'to\nken', 'töken'])(
    'rejects non-canonical access token %j',
    async token => {
      const fetchMock = vi.fn();

      await expect(
        listBitbucketWorkspaceRepositories({
          accessToken: token,
          workspace: { slug: 'acme', uuid: workspaceUuid },
          fetch: fetchMock,
        })
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    { slug: 'acme/other', uuid: workspaceUuid },
    { slug: '.', uuid: workspaceUuid },
    { slug: 'acme', uuid: 'not-a-uuid' },
  ])('rejects invalid selected workspace %#', async workspace => {
    const fetchMock = vi.fn();

    await expect(
      listBitbucketWorkspaceRepositories({ accessToken, workspace, fetch: fetchMock })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows a validated opaque next link', async () => {
    const next =
      'https://api.bitbucket.org/2.0/repositories/acme?cursor=opaque%2F%5C%2Evalue&pagelen=%35%30';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          pagelen: 50,
          values: [
            {
              uuid: `{${repositoryUuid}}`,
              name: 'Widgets',
              slug: 'widgets',
              full_name: 'acme/widgets',
              is_private: true,
              workspace: { uuid: `{${workspaceUuid}}`, slug: 'acme' },
              mainbranch: { name: 'main' },
            },
          ],
          next,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          pagelen: 50,
          values: [
            {
              uuid: anotherRepositoryUuid,
              name: 'Tools',
              slug: 'tools',
              full_name: 'acme/tools',
              is_private: false,
              workspace: { uuid: workspaceUuid, slug: 'acme' },
              mainbranch: null,
            },
          ],
        })
      );

    const repositories = await listBitbucketWorkspaceRepositories({
      accessToken,
      workspace: { slug: 'acme', uuid: workspaceUuid },
      fetch: fetchMock,
    });

    expect(repositories.map(repository => repository.id)).toEqual([
      repositoryUuid,
      anotherRepositoryUuid,
    ]);
    expect(repositories[1]).not.toHaveProperty('defaultBranch');
    expect(fetchMock).toHaveBeenNthCalledWith(2, next, expect.any(Object));
  });

  it.each([
    [401, 'authentication_rejected'],
    [403, 'insufficient_permissions'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ] as const)('classifies provider status %s as %s', async (status, code) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: 'rejected' } }, { status }));

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code });
  });

  it('classifies transport failures without exposing provider details', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(`Bearer ${accessToken}`));

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'transport_failed' });
  });

  it('times out a provider request', async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
        requestTimeoutMs: 5,
      })
    ).rejects.toMatchObject({ code: 'request_timed_out' });
  });

  it('times out while reading a provider response body', async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                once: true,
              });
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        )
      );
    });

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
        requestTimeoutMs: 5,
      })
    ).rejects.toMatchObject({ code: 'request_timed_out' });
  });

  it('rejects unexpected successful provider statuses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ pagelen: 50, values: [] }, { status: 201 }));

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'request_failed' });
  });

  it('requires a JSON provider response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ pagelen: 50, values: [] }), {
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects a response whose declared size exceeds the JSON response bound', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { pagelen: 50, values: [] },
          { headers: { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) } }
        )
      );

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('stops reading when the streamed JSON body exceeds the response bound', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('x'.repeat(MAX_RESPONSE_BYTES + 1), {
        headers: {
          'Content-Length': '10',
          'Content-Type': 'application/json',
        },
      })
    );

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it.each([
    {},
    { pagelen: '50', values: [] },
    { pagelen: REPOSITORY_PAGE_LENGTH + 1, values: [] },
    { pagelen: 50, values: 'not-an-array' },
    {
      pagelen: 1,
      values: [
        repositoryPayload(),
        repositoryPayload({
          uuid: `{${anotherRepositoryUuid}}`,
          name: 'Tools',
          slug: 'tools',
          full_name: 'acme/tools',
        }),
      ],
    },
    { pagelen: 50, values: [repositoryPayload({ uuid: 'not-a-uuid' })] },
    { pagelen: 50, values: [repositoryPayload({ is_private: 'true' })] },
    { pagelen: 50, values: [repositoryPayload({ mainbranch: { name: '' } })] },
  ])('rejects a malformed repository page %#', async payload => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    repositoryPayload({
      workspace: { uuid: '{00000000-0000-0000-0000-000000000001}', slug: 'acme' },
    }),
    repositoryPayload({ workspace: { uuid: `{${workspaceUuid}}`, slug: 'other' } }),
    repositoryPayload({ full_name: 'other/widgets' }),
  ])('rejects a repository outside the selected workspace contract %#', async repository => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ pagelen: 50, values: [repository] }));

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'workspace_mismatch' });
  });

  it('classifies malformed repository identity separately from workspace mismatch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        pagelen: 50,
        values: [repositoryPayload({ slug: '../widgets', full_name: 'acme/../widgets' })],
      })
    );

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects duplicate repository paths with inconsistent UUIDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        pagelen: 50,
        values: [repositoryPayload(), repositoryPayload({ uuid: `{${anotherRepositoryUuid}}` })],
      })
    );

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('discards earlier pages when a later page is invalid', async () => {
    const next = 'https://api.bitbucket.org/2.0/repositories/acme?page=2&pagelen=50';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ pagelen: 50, values: [repositoryPayload()], next }))
      .mockResolvedValueOnce(jsonResponse({ pagelen: 50, values: 'invalid' }));

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('enforces the named page traversal cap', async () => {
    let requestCount = 0;
    const fetchMock = vi.fn(async () => {
      requestCount += 1;
      return jsonResponse({
        pagelen: 50,
        values: [],
        next: `https://api.bitbucket.org/2.0/repositories/acme?page=${requestCount + 1}&pagelen=50`,
      });
    });

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'page_limit_exceeded' });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REPOSITORY_PAGES);
  });

  it('enforces the named repository item cap', async () => {
    let requestCount = 0;
    const fetchMock = vi.fn(async () => {
      const firstItem = requestCount * REPOSITORY_PAGE_LENGTH + 1;
      requestCount += 1;
      return jsonResponse({
        pagelen: REPOSITORY_PAGE_LENGTH,
        values: Array.from({ length: REPOSITORY_PAGE_LENGTH }, (_, offset) => {
          const index = firstItem + offset;
          return repositoryPayload({
            uuid: `{${numberedUuid(index)}}`,
            name: `Repository ${index}`,
            slug: `repository-${index}`,
            full_name: `acme/repository-${index}`,
            mainbranch: null,
          });
        }),
        next: `https://api.bitbucket.org/2.0/repositories/acme?page=${requestCount + 1}&pagelen=50`,
      });
    });

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'item_limit_exceeded' });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REPOSITORY_ITEMS / REPOSITORY_PAGE_LENGTH);
  });

  it('rejects redirects without following their location', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example/repositories' },
      })
    );

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'redirect_rejected' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { redirected: true, url: 'https://evil.example/repositories' },
    {
      redirected: false,
      url: 'https://api.bitbucket.org/2.0/repositories/other?pagelen=50',
    },
  ])('rejects a successful response reached through another URL %#', async responseMetadata => {
    const response = jsonResponse({ pagelen: 50, values: [] });
    Object.defineProperties(response, {
      redirected: { value: responseMetadata.redirected },
      url: { value: responseMetadata.url },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'redirect_rejected' });
  });

  it.each([
    ['fixed-host', 'http://api.bitbucket.org/2.0/repositories/acme?pagelen=50'],
    ['fixed-host', 'https://evil.example/2.0/repositories/acme?pagelen=50'],
    ['fixed-host', 'https://api.bitbucket.org:443/2.0/repositories/acme?pagelen=50'],
    ['fixed-host', 'https://api.bitbucket.org:8443/2.0/repositories/acme?pagelen=50'],
    ['fixed-host', 'HTTPS://api.bitbucket.org/2.0/repositories/acme?pagelen=50'],
    ['fixed-host', 'https://API.bitbucket.org/2.0/repositories/acme?pagelen=50'],
    ['credentials', 'https://user@api.bitbucket.org/2.0/repositories/acme?pagelen=50'],
    ['credentials', 'https://user:password@api.bitbucket.org/2.0/repositories/acme?pagelen=50'],
    ['path', 'https://api.bitbucket.org/2.0/repositories/other?pagelen=50'],
    ['path', 'https://api.bitbucket.org/2.0/repositories/acme/widgets?pagelen=50'],
    ['path', 'https://api.bitbucket.org/2.0/repositories/acme%2Fother?pagelen=50'],
    ['path', 'https://api.bitbucket.org/2.0/repositories/other/../acme?pagelen=50'],
    ['path', 'https://api.bitbucket.org/2.0/repositories/other/%2e%2e/acme?pagelen=50'],
    ['path', 'https://api.bitbucket.org/2.0/repositories/acme?pagelen=50#fragment'],
    ['path', 'https://api.bitbucket.org/2.0/repositories/acme?pagelen=50#'],
    ['query', 'https://api.bitbucket.org/2.0/repositories/acme?cursor=%ZZ'],
    ['query', 'https://api.bitbucket.org/2.0/repositories/acme?cursor=opaque\tvalue&pagelen=50'],
    [
      'query',
      'https://api.bitbucket.org/2.0/repositories/acme?cursor=opaque\u00a0value&pagelen=50',
    ],
    ['page length', 'https://api.bitbucket.org/2.0/repositories/acme?pagelen=51'],
    ['page length', 'https://api.bitbucket.org/2.0/repositories/acme?pagelen=0'],
    ['page length', 'https://api.bitbucket.org/2.0/repositories/acme?pagelen=50&pagelen=10'],
    ['case-variant query', 'https://api.bitbucket.org/2.0/repositories/acme?Pagelen=50'],
    ['case-variant query', 'https://api.bitbucket.org/2.0/repositories/acme?PAGELEN=50'],
    ['cyclic', 'https://api.bitbucket.org/2.0/repositories/acme?pagelen=50'],
  ])('rejects a hostile %s next link %s before another fetch', async (_category, next) => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        pagelen: 50,
        values: [],
        next,
      })
    );

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'invalid_pagination', message: 'invalid_pagination' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a role-filtered next link before another fetch', async () => {
    const next = 'https://api.bitbucket.org/2.0/repositories/acme?role=contributor&pagelen=50';
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        pagelen: 50,
        values: [],
        next,
      })
    );

    await expect(
      listBitbucketWorkspaceRepositories({
        accessToken,
        workspace: { slug: 'acme', uuid: workspaceUuid },
        fetch: fetchMock,
      })
    ).rejects.toMatchObject({ code: 'invalid_pagination', message: 'invalid_pagination' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sanitizes transport, provider, and payload failures', async () => {
    const sensitiveFailure = `Authorization: Bearer ${accessToken}`;
    const fetchImplementations = [
      vi.fn().mockRejectedValue(new Error(sensitiveFailure)),
      vi.fn().mockResolvedValue(new Response(sensitiveFailure, { status: 502 })),
      vi
        .fn()
        .mockResolvedValue(
          new Response(sensitiveFailure, { headers: { 'Content-Type': 'application/json' } })
        ),
      vi.fn().mockResolvedValue(
        jsonResponse({
          pagelen: 50,
          values: [],
          next: `https://${accessToken}@api.bitbucket.org/2.0/repositories/acme?pagelen=50`,
        })
      ),
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(sensitiveFailure));
            },
          })
        )
      ),
    ];

    for (const fetchImplementation of fetchImplementations) {
      let thrown: unknown;
      try {
        await listBitbucketWorkspaceRepositories({
          accessToken,
          workspace: { slug: 'acme', uuid: workspaceUuid },
          fetch: fetchImplementation,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const errorText =
        thrown instanceof Error
          ? `${thrown.name} ${thrown.message} ${thrown.stack ?? ''}`
          : String(thrown);
      expect(errorText).not.toContain(accessToken);
      expect(errorText).not.toContain('Authorization');
      expect(JSON.stringify(thrown)).not.toContain(accessToken);
    }
  });
});
