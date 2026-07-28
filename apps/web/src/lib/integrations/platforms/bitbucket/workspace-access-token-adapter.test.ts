import {
  validateBitbucketWorkspaceAccessToken,
  type BitbucketWorkspaceAccessTokenRepository,
} from './workspace-access-token-adapter';

const ACCESS_TOKEN = 'ATCT-successful-workspace-token';
const WORKSPACE_UUID = '11111111-1111-4111-8111-111111111111';

function authenticatedJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('X-Credential-Type', 'workspace_access_token');
  if (!headers.has('X-OAuth-Scopes')) {
    headers.set('X-OAuth-Scopes', 'repository:write account pullrequest webhook');
  }
  return Response.json(body, { ...init, headers });
}

function workspaceDiscoveryJson(
  overrides: Record<string, unknown> = {},
  init: ResponseInit = {}
): Response {
  return authenticatedJson(
    {
      pagelen: 2,
      values: [
        {
          workspace: {
            uuid: `{${WORKSPACE_UUID.toUpperCase()}}`,
            slug: 'acme',
            ...overrides,
          },
        },
      ],
    },
    init
  );
}

function workspaceDetailsJson(): Response {
  return authenticatedJson({
    uuid: `{${WORKSPACE_UUID.toUpperCase()}}`,
    slug: 'acme',
    name: 'Acme Workspace',
    links: { self: { href: 'must-not-be-projected' } },
  });
}

function repository(
  uuid: string,
  slug: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    uuid: `{${uuid}}`,
    name: slug === 'api' ? 'API' : 'Web',
    slug,
    full_name: `acme/${slug}`,
    is_private: true,
    workspace: {
      uuid: `{${WORKSPACE_UUID}}`,
      slug: 'acme',
    },
    mainbranch: { name: 'main' },
    ...overrides,
  };
}

function generatedRepository(index: number): Record<string, unknown> {
  const uuidSuffix = index.toString(16).padStart(12, '0');
  return repository(`00000000-0000-4000-8000-${uuidSuffix}`, `repo-${index}`);
}

function expectedRepository(
  id: string,
  name: string,
  fullName: string
): BitbucketWorkspaceAccessTokenRepository {
  return {
    id,
    workspaceUuid: WORKSPACE_UUID,
    name,
    fullName,
    private: true,
    defaultBranch: 'main',
  };
}

describe('Bitbucket Workspace Access Token adapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('validates the workspace-bound credential and returns the complete repository projection', async () => {
    const secondPageUrl = 'https://api.bitbucket.org/2.0/repositories/acme?pagelen=50&page=2';
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(workspaceDiscoveryJson())
      .mockResolvedValueOnce(workspaceDetailsJson())
      .mockResolvedValueOnce(authenticatedJson({ pagelen: 1, values: [] }))
      .mockResolvedValueOnce(
        authenticatedJson({
          pagelen: 50,
          values: [repository('22222222-2222-4222-8222-222222222222', 'api')],
          next: secondPageUrl,
        })
      )
      .mockResolvedValueOnce(
        authenticatedJson({
          pagelen: 50,
          values: [repository('33333333-3333-4333-8333-333333333333', 'web')],
        })
      );

    await expect(
      validateBitbucketWorkspaceAccessToken({
        accessToken: ACCESS_TOKEN,
      })
    ).resolves.toEqual({
      workspace: {
        uuid: WORKSPACE_UUID,
        slug: 'acme',
        displayName: 'Acme Workspace',
      },
      providerCredentialType: 'workspace_access_token',
      providerScopes: ['account', 'pullrequest', 'repository:write', 'webhook'],
      repositories: [
        expectedRepository('22222222-2222-4222-8222-222222222222', 'API', 'acme/api'),
        expectedRepository('33333333-3333-4333-8333-333333333333', 'Web', 'acme/web'),
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.bitbucket.org/2.0/user/workspaces?pagelen=2',
      'https://api.bitbucket.org/2.0/workspaces/acme',
      'https://api.bitbucket.org/2.0/workspaces/acme/members?pagelen=1',
      'https://api.bitbucket.org/2.0/repositories/acme?pagelen=50',
      secondPageUrl,
    ]);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain('role=contributor');
      expect(init).toEqual(
        expect.objectContaining({
          redirect: 'manual',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${ACCESS_TOKEN}`,
          },
          signal: expect.any(AbortSignal),
        })
      );
    }
  });

  it('aggregates token scope evidence across validation requests', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        workspaceDiscoveryJson(
          {},
          {
            headers: {
              'X-OAuth-Scopes': 'account webhook',
            },
          }
        )
      )
      .mockResolvedValueOnce(workspaceDetailsJson())
      .mockResolvedValueOnce(authenticatedJson({ pagelen: 1, values: [] }))
      .mockResolvedValueOnce(
        authenticatedJson({
          pagelen: 50,
          values: [repository('22222222-2222-4222-8222-222222222222', 'api')],
        })
      );

    await expect(
      validateBitbucketWorkspaceAccessToken({
        accessToken: ACCESS_TOKEN,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        providerScopes: ['account', 'pullrequest', 'repository:write', 'webhook'],
      })
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('rejects missing credential-type evidence before requesting members or repositories', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json(
        {
          pagelen: 2,
          values: [{ workspace: { uuid: `{${WORKSPACE_UUID}}`, slug: 'acme' } }],
        },
        {
          headers: {
            'X-OAuth-Scopes': 'account repository:write pullrequest webhook',
          },
        }
      )
    );

    await expect(
      validateBitbucketWorkspaceAccessToken({
        accessToken: ACCESS_TOKEN,
      })
    ).rejects.toMatchObject({ code: 'credential_type_missing' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.bitbucket.org/2.0/workspaces/acme/members?pagelen=1',
      expect.anything()
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.bitbucket.org/2.0/repositories/acme?pagelen=50',
      expect.anything()
    );
  });

  it('rejects ambiguous workspace discovery before requesting workspace details', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      authenticatedJson({
        pagelen: 2,
        values: [
          { workspace: { uuid: `{${WORKSPACE_UUID}}`, slug: 'acme' } },
          {
            workspace: {
              uuid: '{44444444-4444-4444-8444-444444444444}',
              slug: 'other',
            },
          },
        ],
      })
    );

    await expect(
      validateBitbucketWorkspaceAccessToken({
        accessToken: ACCESS_TOKEN,
      })
    ).rejects.toMatchObject({ code: 'workspace_discovery_failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects credentials that Bitbucket classifies as another token type', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json(
        {
          pagelen: 2,
          values: [{ workspace: { uuid: `{${WORKSPACE_UUID}}`, slug: 'acme' } }],
        },
        {
          headers: {
            'X-Credential-Type': 'repo_access_token',
            'X-OAuth-Scopes': 'account repository:write pullrequest webhook',
          },
        }
      )
    );

    const validation = validateBitbucketWorkspaceAccessToken({
      accessToken: ACCESS_TOKEN,
    });
    await expect(validation).rejects.toMatchObject({
      name: 'BitbucketWorkspaceAccessTokenError',
      code: 'credential_type_invalid',
    });
    await expect(validation).rejects.not.toThrow(ACCESS_TOKEN);
  });

  it.each([
    [undefined, 'scope_evidence_missing'],
    ['account repository', 'insufficient_scopes'],
    ['account repository:write', 'insufficient_scopes'],
    ['account repository:write webhook', 'insufficient_scopes'],
    ['repository:write', 'insufficient_scopes'],
  ] as const)('rejects missing required provider scopes', async (scopeHeader, expectedCode) => {
    const headers: Record<string, string> = {
      'X-Credential-Type': 'workspace_access_token',
    };
    if (scopeHeader) {
      const scopedResponse = {
        headers: {
          'X-OAuth-Scopes': scopeHeader,
        },
      };
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(workspaceDiscoveryJson({}, scopedResponse))
        .mockResolvedValueOnce(
          authenticatedJson(
            { uuid: `{${WORKSPACE_UUID}}`, slug: 'acme', name: 'Acme Workspace' },
            scopedResponse
          )
        )
        .mockResolvedValueOnce(authenticatedJson({ pagelen: 1, values: [] }, scopedResponse))
        .mockResolvedValueOnce(authenticatedJson({ pagelen: 50, values: [] }, scopedResponse));
    } else {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce(
        Response.json(
          {
            pagelen: 2,
            values: [{ workspace: { uuid: `{${WORKSPACE_UUID}}`, slug: 'acme' } }],
          },
          { headers }
        )
      );
    }

    await expect(
      validateBitbucketWorkspaceAccessToken({
        accessToken: ACCESS_TOKEN,
      })
    ).rejects.toMatchObject({ code: expectedCode });
  });

  it('names the missing required provider scopes without exposing the token', async () => {
    const scopedResponse = {
      headers: {
        'X-OAuth-Scopes': 'account repository:write',
      },
    };
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(workspaceDiscoveryJson({}, scopedResponse))
      .mockResolvedValueOnce(
        authenticatedJson(
          {
            uuid: `{${WORKSPACE_UUID}}`,
            slug: 'acme',
            name: 'Acme Workspace',
          },
          scopedResponse
        )
      )
      .mockResolvedValueOnce(authenticatedJson({ pagelen: 1, values: [] }, scopedResponse))
      .mockResolvedValueOnce(authenticatedJson({ pagelen: 50, values: [] }, scopedResponse));

    const validation = validateBitbucketWorkspaceAccessToken({
      accessToken: ACCESS_TOKEN,
    });

    await expect(validation).rejects.toMatchObject({
      code: 'insufficient_scopes',
      message:
        'The Bitbucket Workspace Access Token is missing required permissions: Pull request Read, Webhooks Read and Write',
    });
    await expect(validation).rejects.not.toThrow(ACCESS_TOKEN);
  });

  it('rejects a credential whose workspace UUID differs from the expected binding', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(workspaceDiscoveryJson());

    await expect(
      validateBitbucketWorkspaceAccessToken({
        expectedWorkspaceUuid: '44444444-4444-4444-8444-444444444444',
        accessToken: ACCESS_TOKEN,
      })
    ).rejects.toMatchObject({ code: 'workspace_mismatch' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires access to the submitted workspace members endpoint', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(workspaceDiscoveryJson())
      .mockResolvedValueOnce(workspaceDetailsJson())
      .mockResolvedValueOnce(new Response(null, { status: 403 }));

    await expect(
      validateBitbucketWorkspaceAccessToken({
        accessToken: ACCESS_TOKEN,
      })
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects non-ATCT credentials before making a provider request', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');

    await expect(
      validateBitbucketWorkspaceAccessToken({
        accessToken: 'oauth-secret-that-must-not-leak',
      })
    ).rejects.toMatchObject({ code: 'invalid_token_format' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      () =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { Location: 'https://evil.example' } })
        ),
      'redirect_rejected',
    ],
    [() => Promise.reject(new DOMException('timed out', 'TimeoutError')), 'request_timeout'],
    [
      () =>
        Promise.resolve(
          new Response('{}', {
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': '1000001',
            },
          })
        ),
      'response_too_large',
    ],
  ] as const)(
    'sanitizes bounded provider transport failures',
    async (providerResult, expectedCode) => {
      jest.spyOn(global, 'fetch').mockImplementationOnce(providerResult);

      const validation = validateBitbucketWorkspaceAccessToken({
        accessToken: ACCESS_TOKEN,
      });
      await expect(validation).rejects.toMatchObject({ code: expectedCode });
      await expect(validation).rejects.not.toThrow(ACCESS_TOKEN);
    }
  );

  it('classifies a timeout that aborts response body streaming after headers arrive', async () => {
    const abortController = new AbortController();
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(abortController.signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        abortController.signal.addEventListener('abort', () => {
          controller.error(abortController.signal.reason);
        });
      },
    });
    jest.spyOn(global, 'fetch').mockImplementationOnce(async () => {
      queueMicrotask(() => {
        abortController.abort(new DOMException('Provider request timed out', 'TimeoutError'));
      });
      return new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Credential-Type': 'workspace_access_token',
          'X-OAuth-Scopes': 'repository:write account pullrequest webhook',
        },
      });
    });

    await expect(
      validateBitbucketWorkspaceAccessToken({
        accessToken: ACCESS_TOKEN,
      })
    ).rejects.toMatchObject({ code: 'request_timeout' });
  });

  it.each(['Pagelen', 'PAGELEN'])(
    'rejects repository pagination with the case-variant %s query parameter',
    async pageLengthName => {
      const unsafeNext = `https://api.bitbucket.org/2.0/repositories/acme?${pageLengthName}=50&page=2`;
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(workspaceDiscoveryJson())
        .mockResolvedValueOnce(workspaceDetailsJson())
        .mockResolvedValueOnce(authenticatedJson({ pagelen: 1, values: [] }))
        .mockResolvedValueOnce(authenticatedJson({ pagelen: 50, values: [], next: unsafeNext }));

      await expect(
        validateBitbucketWorkspaceAccessToken({
          accessToken: ACCESS_TOKEN,
        })
      ).rejects.toMatchObject({ code: 'invalid_pagination' });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock).not.toHaveBeenCalledWith(unsafeNext, expect.anything());
    }
  );

  it('rejects repository pagination that introduces role=contributor', async () => {
    const unsafeNext =
      'https://api.bitbucket.org/2.0/repositories/acme?role=contributor&pagelen=50&page=2';
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(workspaceDiscoveryJson())
      .mockResolvedValueOnce(workspaceDetailsJson())
      .mockResolvedValueOnce(authenticatedJson({ pagelen: 1, values: [] }))
      .mockResolvedValueOnce(authenticatedJson({ pagelen: 50, values: [], next: unsafeNext }));

    await expect(
      validateBitbucketWorkspaceAccessToken({
        accessToken: ACCESS_TOKEN,
      })
    ).rejects.toMatchObject({ code: 'invalid_pagination' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).not.toHaveBeenCalledWith(unsafeNext, expect.anything());
  });

  it('stops repository pagination at the page limit', async () => {
    let repositoryPage = 0;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async url => {
      const endpoint = String(url);
      if (endpoint.endsWith('/user/workspaces?pagelen=2')) {
        return workspaceDiscoveryJson();
      }
      if (endpoint.endsWith('/workspaces/acme')) {
        return workspaceDetailsJson();
      }
      if (endpoint.includes('/members?')) {
        return authenticatedJson({ pagelen: 1, values: [] });
      }
      repositoryPage += 1;
      return authenticatedJson({
        pagelen: 50,
        values: [],
        next: `https://api.bitbucket.org/2.0/repositories/acme?pagelen=50&page=${repositoryPage + 1}`,
      });
    });

    await expect(
      validateBitbucketWorkspaceAccessToken({
        accessToken: ACCESS_TOKEN,
      })
    ).rejects.toMatchObject({ code: 'page_limit_exceeded' });
    expect(repositoryPage).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(103);
  });

  it('stops repository pagination at the item limit', async () => {
    let repositoryPage = 0;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async url => {
      const endpoint = String(url);
      if (endpoint.endsWith('/user/workspaces?pagelen=2')) {
        return workspaceDiscoveryJson();
      }
      if (endpoint.endsWith('/workspaces/acme')) {
        return workspaceDetailsJson();
      }
      if (endpoint.includes('/members?')) {
        return authenticatedJson({ pagelen: 1, values: [] });
      }
      const firstIndex = repositoryPage * 50 + 1;
      repositoryPage += 1;
      return authenticatedJson({
        pagelen: 50,
        values: Array.from({ length: 50 }, (_, offset) => generatedRepository(firstIndex + offset)),
        next: `https://api.bitbucket.org/2.0/repositories/acme?pagelen=50&page=${repositoryPage + 1}`,
      });
    });

    await expect(
      validateBitbucketWorkspaceAccessToken({
        accessToken: ACCESS_TOKEN,
      })
    ).rejects.toMatchObject({ code: 'item_limit_exceeded' });
    expect(repositoryPage).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(103);
  });

  it('rejects repository projections outside the exact workspace full name', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(workspaceDiscoveryJson())
      .mockResolvedValueOnce(workspaceDetailsJson())
      .mockResolvedValueOnce(authenticatedJson({ pagelen: 1, values: [] }))
      .mockResolvedValueOnce(
        authenticatedJson({
          pagelen: 50,
          values: [
            repository('22222222-2222-4222-8222-222222222222', 'api', {
              full_name: 'other/api',
            }),
          ],
        })
      );

    await expect(
      validateBitbucketWorkspaceAccessToken({
        accessToken: ACCESS_TOKEN,
      })
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
