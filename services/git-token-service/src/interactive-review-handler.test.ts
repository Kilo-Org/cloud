import { getWorkerDb } from '@kilocode/db/client';
import type * as DbClientModule from '@kilocode/db/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BitbucketRuntimeTokenResolverModule from './bitbucket-runtime-token-resolver.js';
import type { BitbucketInteractiveBrokerRequest } from './bitbucket-interactive-api.js';
import {
  buildBitbucketInteractiveIntegrationQuery,
  handleBitbucketInteractiveReview,
} from './interactive-review-handler.js';

const mocks = vi.hoisted(() => ({ rows: vi.fn(), resolve: vi.fn(), invalidate: vi.fn() }));
vi.mock('@kilocode/db/client', async importOriginal => {
  const actual = await importOriginal<typeof DbClientModule>();
  const query = {
    select: () => query,
    from: () => query,
    innerJoin: () => query,
    leftJoin: () => query,
    where: () => query,
    limit: () => ({ then: (resolve: (rows: unknown) => void) => mocks.rows().then(resolve) }),
  };
  return {
    ...actual,
    getWorkerDb: (url: string) => (url === 'test' ? query : actual.getWorkerDb(url)),
  };
});
vi.mock('./bitbucket-runtime-token-resolver.js', async importOriginal => ({
  ...(await importOriginal<typeof BitbucketRuntimeTokenResolverModule>()),
  resolveBitbucketCapabilitySubject: mocks.resolve,
}));
vi.mock('./bitbucket-workspace-access-token-authorization-service.js', () => ({
  BitbucketWorkspaceAccessTokenAuthorizationService: class {
    invalidateAuthorization = mocks.invalidate;
  },
}));

const owner = { userId: 'oauth/member', orgId: '123e4567-e89b-12d3-a456-426614174030' };
const target = {
  integrationId: '123e4567-e89b-12d3-a456-426614174033',
  workspaceUuid: '123e4567-e89b-12d3-a456-426614174031',
  workspaceSlug: 'acme',
  repositoryUuid: '123e4567-e89b-12d3-a456-426614174032',
  repositoryFullName: 'acme/widgets',
};
const readScopes = ['account', 'pullrequest', 'repository', 'repository:write', 'webhook'];
const integration = {
  ...target,
  integrationType: 'workspace_access_token',
  accessId: 'credential-1',
  accessVersion: 7,
  accessScopes: readScopes,
  scopes: readScopes,
  oauthId: 'oauth-credential',
  actorId: 'provider-user',
  actorLogin: 'provider-login',
  repositoriesSyncedAt: '2026-04-29 01:16:12.945+00',
  repositories: [
    {
      id: target.repositoryUuid,
      name: 'Widgets',
      full_name: target.repositoryFullName,
      private: true,
    },
  ],
};
const request = {
  operation: 'pullRequest',
  params: { path: { workspace: 'acme', repo_slug: 'widgets', pull_request_id: 7 } },
};
const env = { HYPERDRIVE: { connectionString: 'test' } } as CloudflareEnv;
const sourceSelector = {
  pullRequestId: 7,
  workspaceUuid: '123e4567-e89b-12d3-a456-426614174098',
  repositoryUuid: '123e4567-e89b-12d3-a456-426614174099',
};
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const fork = {
  type: 'pullrequest',
  id: 7,
  source: {
    commit: { hash: sourceCommit },
    repository: {
      uuid: `{${sourceSelector.repositoryUuid}}`,
      full_name: 'fork/widgets',
      workspace: { uuid: `{${sourceSelector.workspaceUuid}}`, slug: 'fork' },
    },
  },
  destination: {
    repository: {
      uuid: `{${target.repositoryUuid}}`,
      full_name: target.repositoryFullName,
      workspace: { uuid: `{${target.workspaceUuid}}`, slug: target.workspaceSlug },
    },
  },
};
const sourceFileRequest = {
  operation: 'file',
  params: {
    path: { workspace: 'acme', repo_slug: 'widgets', commit: sourceCommit, path: 'src/file.ts' },
  },
  source: sourceSelector,
} satisfies BitbucketInteractiveBrokerRequest<'file'>;
const destinationApiPath = `/2.0/repositories/%7B${target.workspaceUuid}%7D/%7B${target.repositoryUuid}%7D`;
const sourceApiPath = `/2.0/repositories/%7B${sourceSelector.workspaceUuid}%7D/%7B${sourceSelector.repositoryUuid}%7D`;
const sourceFileMetadata = {
  type: 'commit_file',
  path: 'src/file.ts',
  size: 17,
  attributes: [],
  commit: { hash: sourceCommit },
};
const providerFetch = vi.fn();
const run = (input: unknown = { ...target, request }, actor = owner) =>
  handleBitbucketInteractiveReview(env, actor, input);

beforeEach(() => {
  mocks.rows.mockReset().mockResolvedValue([integration]);
  mocks.resolve.mockReset().mockResolvedValue({
    success: true,
    subject: {
      ...target,
      repositoryFullName: target.repositoryFullName,
      token: 'provider-secret',
    },
  });
  mocks.invalidate.mockReset().mockResolvedValue(undefined);
  providerFetch.mockReset().mockImplementation(async () => Response.json(fork));
  vi.stubGlobal('fetch', providerFetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('interactive Bitbucket authorization', () => {
  it.each([
    ['workspace_access_token', 'file'],
    ['workspace_access_token', 'fileMetadata'],
    ['oauth', 'file'],
    ['oauth', 'fileMetadata'],
  ] as const)(
    'reads immutable fork %s %s through the authorized destination pull request',
    async (integrationType, operation) => {
      mocks.rows.mockResolvedValue([{ ...integration, integrationType }]);
      const visits: string[] = [];
      providerFetch.mockImplementation(async (url, options) => {
        const endpoint = new URL(String(url));
        visits.push(endpoint.pathname);
        if (
          options.method !== 'GET' ||
          new Headers(options.headers).get('authorization') !== 'Bearer provider-secret'
        )
          return Response.json({}, { status: 403 });
        if (endpoint.pathname === `${destinationApiPath}/pullrequests/7`) {
          return Response.json(
            endpoint.searchParams.get('fields') ===
              '+source.repository.workspace,+destination.repository.workspace'
              ? fork
              : {
                  ...fork,
                  source: {
                    ...fork.source,
                    repository: { ...fork.source.repository, workspace: undefined },
                  },
                }
          );
        }
        if (endpoint.pathname !== `${sourceApiPath}/src/${sourceCommit}/src%2Ffile.ts`)
          return Response.json({}, { status: 404 });
        return endpoint.searchParams.get('format') === 'meta'
          ? Response.json(sourceFileMetadata)
          : new Response('const value = 1;\n', { headers: { 'content-type': 'text/plain' } });
      });
      const result = await run({ ...target, request: { ...sourceFileRequest, operation } });
      expect(result, JSON.stringify(result)).toMatchObject({
        success: true,
        result: {
          status: 200,
          data: operation === 'file' ? 'const value = 1;\n' : sourceFileMetadata,
        },
        metadata: {
          actorUserId: owner.userId,
          organizationId: owner.orgId,
          integrationId: target.integrationId,
          providerActor:
            integrationType === 'oauth'
              ? { credentialKind: 'bitbucketOAuth', actor: { id: integration.actorId } }
              : {
                  credentialKind: 'bitbucketWorkspaceToken',
                  workspaceUuid: target.workspaceUuid,
                },
          grants: { scopes: readScopes },
        },
      });
      expect(JSON.stringify(result)).not.toContain('provider-secret');
      expect(visits).toEqual([
        `${destinationApiPath}/pullrequests/7`,
        `${sourceApiPath}/src/${sourceCommit}/src%2Ffile.ts`,
      ]);
    }
  );

  it('queries the exact active organization integration for an unblocked member or administrator', () => {
    const query = buildBitbucketInteractiveIntegrationQuery(
      getWorkerDb('postgres://unused:unused@localhost:0/unused'),
      owner,
      target.integrationId
    ).toSQL();
    for (const guard of [
      '"platform_integrations"."id" =',
      '"owned_by_organization_id" =',
      '"owned_by_user_id" is null',
      '"integration_status" =',
      '"auth_invalid_at" is null',
      '"blocked_reason" is null',
      '"organization_memberships"."id" is not null',
      '"kilocode_users"."is_admin" =',
    ])
      expect(query.sql).toContain(guard);
    expect(query.params).toEqual(
      expect.arrayContaining([
        owner.userId,
        owner.orgId,
        target.integrationId,
        'active',
        'bitbucket',
      ])
    );
    expect(query.sql).not.toContain('token_encrypted');
  });

  it('reads a fork through the exact destination and returns the actual OAuth actor without credentials', async () => {
    mocks.rows.mockResolvedValue([{ ...integration, integrationType: 'oauth' }]);
    const result = await run();
    expect(result).toEqual({
      success: true,
      result: { status: 200, data: fork },
      metadata: {
        actorUserId: owner.userId,
        organizationId: owner.orgId,
        integrationId: target.integrationId,
        instanceUrl: 'https://bitbucket.org',
        providerActor: {
          credentialKind: 'bitbucketOAuth',
          actor: {
            provider: 'bitbucket',
            instanceUrl: 'https://bitbucket.org',
            id: 'provider-user',
            login: 'provider-login',
            displayName: null,
            avatarUrl: null,
          },
        },
        grants: { scopes: readScopes },
      },
    });
    expect(providerFetch.mock.calls[0][0]).toContain(
      `/repositories/%7B${target.workspaceUuid}%7D/%7B${target.repositoryUuid}%7D/pullrequests/7`
    );
    expect(JSON.stringify(result)).not.toContain('provider-secret');
  });

  it('keeps an authorized empty page and workspace principal distinct from an authorization failure', async () => {
    providerFetch.mockResolvedValue(Response.json({ values: [] }));
    const result = await run({
      ...target,
      request: {
        operation: 'pullRequests',
        params: { path: { workspace: 'acme', repo_slug: 'widgets' } },
      },
    });
    expect(result).toMatchObject({
      success: true,
      result: { status: 200, data: { values: [] } },
      metadata: {
        providerActor: {
          credentialKind: 'bitbucketWorkspaceToken',
          workspaceUuid: target.workspaceUuid,
          workspaceSlug: 'acme',
        },
        grants: { scopes: readScopes },
      },
    });
    if (!result.success) throw new Error('Expected authorization');
    expect(result.metadata.providerActor).not.toHaveProperty('actor');
    expect(JSON.stringify(result)).not.toContain('provider-secret');
  });

  it.each([
    [
      { ...target, workspaceUuid: '123e4567-e89b-12d3-a456-426614174099', request },
      'workspace_mismatch',
    ],
    [{ ...target, repositoryUuid: '123e4567-e89b-12d3-a456-426614174099', request }, 'not_found'],
    [
      { ...target, integrationId: '123e4567-e89b-12d3-a456-426614174099', request },
      'integration_mismatch',
    ],
    [{ ...target, request, instanceUrl: 'https://attacker.example' }, 'invalid_request'],
    [
      { ...target, request, metadata: { grants: { scopes: ['pullrequest:write'] } } },
      'invalid_request',
    ],
    [
      {
        ...target,
        request: { ...request, params: { path: { ...request.params.path, workspace: 'fork' } } },
      },
      'repository_mismatch',
    ],
  ])(
    'rejects mismatched identity or caller metadata before provider access %#',
    async (input, reason) => {
      await expect(run(input)).resolves.toEqual({ success: false, reason });
      expect(providerFetch).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
    }
  );

  it('rejects Personal Bitbucket before credential access', async () => {
    await expect(
      run(undefined, { userId: owner.userId, orgId: undefined } as unknown as typeof owner)
    ).resolves.toEqual({ success: false, reason: 'invalid_request' });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    [
      'wrong organization',
      { ...owner, orgId: '123e4567-e89b-12d3-a456-426614174099' },
      '"owned_by_organization_id" =',
      '123e4567-e89b-12d3-a456-426614174099',
    ],
    ['inactive integration', owner, '"integration_status" =', 'active'],
    [
      'blocked user',
      { ...owner, userId: 'blocked-user' },
      '"blocked_reason" is null',
      'blocked-user',
    ],
  ] as const)('denies %s before credential resolution', async (_case, actor, guard, parameter) => {
    const query = buildBitbucketInteractiveIntegrationQuery(
      getWorkerDb('postgres://unused:unused@localhost:0/unused'),
      actor,
      target.integrationId
    ).toSQL();
    expect(query.sql).toContain(guard);
    expect(query.params).toContain(parameter);
    mocks.rows.mockResolvedValue([]);
    await expect(run(undefined, actor)).resolves.toEqual({
      success: false,
      reason: 'not_connected',
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each(['approve', 'unapprove', 'requestChanges', 'removeChangeRequest', 'merge'])(
    'does not infer the %s grant from repository write access',
    async operation => {
      await expect(run({ ...target, request: { ...request, operation } })).resolves.toEqual({
        success: false,
        reason: 'insufficient_permissions',
      });
      expect(providerFetch).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
    }
  );

  it('permits comments with legacy read grants and the interactive body budget', async () => {
    providerFetch.mockResolvedValue(Response.json({ id: 91 }, { status: 201 }));
    await expect(
      run({
        ...target,
        request: {
          ...request,
          operation: 'createComment',
          body: { content: { raw: 'x'.repeat(17_000) } },
        },
      })
    ).resolves.toMatchObject({
      success: true,
      result: { status: 201, data: { id: 91 } },
      metadata: { grants: { scopes: readScopes } },
    });
  });

  it.each([{ accessVersion: 8 }, { accessId: 'replacement' }, { repositories: [] }])(
    'fences a credential generation or cached identity change during resolution %#',
    async change => {
      mocks.rows
        .mockResolvedValueOnce([integration])
        .mockResolvedValueOnce([{ ...integration, ...change }]);
      const result = await run();
      expect(result).toEqual({
        success: false,
        reason: 'repositories' in change ? 'not_found' : 'reconnect_required',
      });
      expect(providerFetch).not.toHaveBeenCalled();
    }
  );

  it('rejects an arbitrary pagination host without forwarding the credential', async () => {
    await expect(
      run({
        ...target,
        request: {
          operation: 'pullRequests',
          params: { path: { workspace: 'acme', repo_slug: 'widgets' } },
          next: 'https://attacker.example/page/2',
        },
      })
    ).resolves.toEqual({ success: false, reason: 'invalid_pagination' });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('rejects a multibyte body above 256,000 bytes before authorization', async () => {
    await expect(
      run({
        ...target,
        request: {
          ...request,
          operation: 'createComment',
          body: { content: { raw: 'é'.repeat(128_000) } },
        },
      })
    ).resolves.toEqual({ success: false, reason: 'request_too_large' });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'insufficient_permissions'],
    [429, 'rate_limited'],
    [503, 'provider_unavailable'],
  ])('preserves provider failure %s without retrying a mutation', async (status, reason) => {
    providerFetch.mockResolvedValue(new Response(null, { status: Number(status) }));
    await expect(
      run({
        ...target,
        request: { ...request, operation: 'createComment', body: { content: { raw: 'comment' } } },
      })
    ).resolves.toEqual({ success: false, reason });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ oauthId: 'replacement' }, 'pullRequest', 'reconnect_required'],
    [{ actorId: 'replacement-actor' }, 'pullRequest', 'reconnect_required'],
    [{ scopes: readScopes }, 'approve', 'insufficient_permissions'],
  ] as const)(
    'rejects OAuth identity or grant changes during resolution %#',
    async (change, operation, reason) => {
      const oauth = {
        ...integration,
        integrationType: 'oauth',
        scopes: [...readScopes, 'pullrequest:write'],
      };
      mocks.rows.mockResolvedValueOnce([oauth]).mockResolvedValueOnce([{ ...oauth, ...change }]);
      await expect(run({ ...target, request: { ...request, operation } })).resolves.toEqual({
        success: false,
        reason,
      });
      expect(providerFetch).not.toHaveBeenCalled();
    }
  );

  it('generation-fences credential invalidation after provider rejection', async () => {
    const generations = new Map([
      [7, 'active'],
      [8, 'active'],
    ]);
    mocks.invalidate.mockImplementation(async (authorization, reason) => {
      if (
        authorization.credentialId === 'credential-1' &&
        authorization.organizationId === owner.orgId &&
        reason === 'provider_rejected'
      ) {
        generations.set(authorization.credentialVersion, 'reconnect_required');
      }
    });
    providerFetch.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(run()).resolves.toEqual({ success: false, reason: 'authentication_rejected' });
    expect([...generations]).toEqual([
      [7, 'reconnect_required'],
      [8, 'active'],
    ]);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects source branch deletion through destination access for a fork', async () => {
    mocks.rows.mockResolvedValue([
      { ...integration, accessScopes: [...readScopes, 'pullrequest:write'] },
    ]);
    await expect(
      run({
        ...target,
        request: { ...request, operation: 'merge', body: { close_source_branch: true } },
      })
    ).resolves.toEqual({ success: false, reason: 'repository_mismatch' });
    expect(providerFetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET']);
  });

  it.each([
    ['approve', 200],
    ['unapprove', 204],
    ['requestChanges', 200],
    ['removeChangeRequest', 204],
    ['merge', 200],
  ] as const)('permits %s only with the actual PR-write grant', async (operation, status) => {
    mocks.rows.mockResolvedValue([
      { ...integration, accessScopes: [...readScopes, 'pullrequest:write'] },
    ]);
    providerFetch.mockResolvedValue(
      status === 204 ? new Response(null, { status }) : Response.json({ id: 7 }, { status })
    );
    await expect(run({ ...target, request: { ...request, operation } })).resolves.toMatchObject({
      success: true,
      result: { status, data: status === 204 ? null : { id: 7 } },
      metadata: { grants: { scopes: [...readScopes, 'pullrequest:write'] } },
    });
  });

  it('does not inherit source deletion from the pull request when merging a fork', async () => {
    mocks.rows.mockResolvedValue([
      { ...integration, accessScopes: [...readScopes, 'pullrequest:write'] },
    ]);
    let sourceBranchExists = true;
    providerFetch.mockImplementation(async (_url, options) => {
      const body = JSON.parse(typeof options.body === 'string' ? options.body : '{}');
      if (body.close_source_branch !== false) sourceBranchExists = false;
      return Response.json({ id: 7, state: 'MERGED' });
    });
    await expect(
      run({ ...target, request: { ...request, operation: 'merge' } })
    ).resolves.toMatchObject({ success: true, result: { data: { state: 'MERGED' } } });
    expect(sourceBranchExists).toBe(true);
  });

  it('permits source deletion when the source is the authorized repository', async () => {
    mocks.rows.mockResolvedValue([
      { ...integration, accessScopes: [...readScopes, 'pullrequest:write'] },
    ]);
    providerFetch
      .mockResolvedValueOnce(Response.json({ ...fork, source: fork.destination }))
      .mockResolvedValueOnce(Response.json({ id: 7, state: 'MERGED' }));
    await expect(
      run({
        ...target,
        request: { ...request, operation: 'merge', body: { close_source_branch: true } },
      })
    ).resolves.toMatchObject({ success: true, result: { data: { state: 'MERGED' } } });
    expect(providerFetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST']);
  });

  it('never authorizes a direct source write through the destination repository', async () => {
    await expect(
      run({
        ...target,
        request: {
          operation: 'deleteBranch',
          params: { path: { workspace: 'fork', repo_slug: 'widgets', name: 'feature' } },
        },
      })
    ).resolves.toEqual({ success: false, reason: 'repository_mismatch' });
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

describe('destination-authorized source reads', () => {
  const abbreviatedCommit = sourceCommit.slice(0, 12);
  const abbreviatedFork = {
    ...fork,
    source: { ...fork.source, commit: { hash: abbreviatedCommit } },
  };

  it.each(['file', 'fileMetadata'] as const)(
    'resolves abbreviated fork revisions before reading %s at the full SHA',
    async operation => {
      const visits: string[] = [];
      providerFetch.mockImplementation(async (url, options) => {
        const endpoint = new URL(String(url));
        visits.push(endpoint.pathname);
        if (options.method !== 'GET') return Response.json({}, { status: 405 });
        if (endpoint.pathname === `${destinationApiPath}/pullrequests/7`)
          return Response.json(abbreviatedFork);
        if (endpoint.pathname === `${sourceApiPath}/commit/${abbreviatedCommit}`)
          return Response.json({ hash: sourceCommit.toUpperCase() });
        if (endpoint.pathname !== `${sourceApiPath}/src/${sourceCommit}/src%2Ffile.ts`)
          return Response.json({}, { status: 404 });
        return endpoint.searchParams.get('format') === 'meta'
          ? Response.json(sourceFileMetadata)
          : new Response('fork content');
      });
      await expect(
        run({ ...target, request: { ...sourceFileRequest, operation } })
      ).resolves.toMatchObject({
        success: true,
        result: { status: 200, data: operation === 'file' ? 'fork content' : sourceFileMetadata },
      });
      expect(visits).toEqual([
        `${destinationApiPath}/pullrequests/7`,
        `${sourceApiPath}/commit/${abbreviatedCommit}`,
        `${sourceApiPath}/src/${sourceCommit}/src%2Ffile.ts`,
      ]);
    }
  );

  it.each([
    [
      'same prefix, different revision',
      { hash: `${abbreviatedCommit}${'f'.repeat(28)}` },
      'conflict',
    ],
    ['missing hash', {}, 'invalid_response'],
    ['still abbreviated', { hash: abbreviatedCommit }, 'invalid_response'],
    ['different prefix', { hash: 'f'.repeat(40) }, 'invalid_response'],
  ] as const)(
    'rejects resolved source commit %s without reading file content',
    async (_name, commit, reason) => {
      providerFetch
        .mockResolvedValueOnce(Response.json(abbreviatedFork))
        .mockResolvedValueOnce(Response.json(commit));
      await expect(run({ ...target, request: sourceFileRequest })).resolves.toEqual({
        success: false,
        reason,
      });
      expect(providerFetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        `${destinationApiPath}/pullrequests/7`,
        `${sourceApiPath}/commit/${abbreviatedCommit}`,
      ]);
    }
  );

  it('preserves provider denial while resolving an abbreviated source revision', async () => {
    providerFetch
      .mockResolvedValueOnce(Response.json(abbreviatedFork))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(run({ ...target, request: sourceFileRequest })).resolves.toEqual({
      success: false,
      reason: 'insufficient_permissions',
    });
    expect(providerFetch.mock.calls).toHaveLength(2);
  });

  it.each([
    [{ integrationId: sourceSelector.repositoryUuid }, 'integration_mismatch'],
    [{ workspaceUuid: sourceSelector.workspaceUuid }, 'workspace_mismatch'],
    [{ repositoryUuid: sourceSelector.repositoryUuid }, 'not_found'],
    [{ repositoryFullName: 'acme/other' }, 'repository_mismatch'],
  ] as const)(
    'requires the original destination identity before reading the PR %#',
    async (change, reason) => {
      await expect(run({ ...target, ...change, request: sourceFileRequest })).resolves.toEqual({
        success: false,
        reason,
      });
      expect(providerFetch).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
    }
  );

  it('requires destination membership before resolving a source selector', async () => {
    mocks.rows.mockResolvedValue([]);
    await expect(run({ ...target, request: sourceFileRequest })).resolves.toEqual({
      success: false,
      reason: 'not_connected',
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['workspace_access_token', { accessVersion: 8 }, 'reconnect_required'],
    ['workspace_access_token', { accessId: 'replacement' }, 'reconnect_required'],
    [
      'workspace_access_token',
      { accessScopes: ['repository', 'pullrequest'] },
      'insufficient_permissions',
    ],
    ['oauth', { oauthId: 'replacement' }, 'reconnect_required'],
    ['oauth', { actorId: 'replacement' }, 'reconnect_required'],
    ['oauth', { scopes: ['repository', 'pullrequest'] }, 'insufficient_permissions'],
  ] as const)(
    'fences %s credential or grant changes before source reads %#',
    async (integrationType, change, reason) => {
      const initial = { ...integration, integrationType };
      mocks.rows
        .mockResolvedValueOnce([initial])
        .mockResolvedValueOnce([{ ...initial, ...change }]);
      await expect(run({ ...target, request: sourceFileRequest })).resolves.toEqual({
        success: false,
        reason,
      });
      expect(providerFetch).not.toHaveBeenCalled();
    }
  );

  it('rejects a cached destination slug reused by another UUID', async () => {
    mocks.rows.mockResolvedValue([
      {
        ...integration,
        repositories: [{ ...integration.repositories[0], id: sourceSelector.repositoryUuid }],
      },
    ]);
    await expect(run({ ...target, request: sourceFileRequest })).resolves.toEqual({
      success: false,
      reason: 'not_found',
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['missing PR', {}, 'invalid_response'],
    ['wrong PR type', { ...fork, type: 'repository' }, 'invalid_response'],
    ['malformed PR ID', { ...fork, id: '7' }, 'invalid_response'],
    ['wrong PR ID', { ...fork, id: 8 }, 'repository_mismatch'],
    ['missing destination', { ...fork, destination: null }, 'invalid_response'],
    [
      'reused destination slug',
      {
        ...fork,
        destination: {
          repository: { ...fork.destination.repository, uuid: fork.source.repository.uuid },
        },
      },
      'repository_mismatch',
    ],
    [
      'wrong destination name',
      {
        ...fork,
        destination: { repository: { ...fork.destination.repository, full_name: 'acme/other' } },
      },
      'repository_mismatch',
    ],
    [
      'wrong destination workspace',
      {
        ...fork,
        destination: {
          repository: {
            ...fork.destination.repository,
            workspace: {
              ...fork.destination.repository.workspace,
              uuid: sourceSelector.workspaceUuid,
            },
          },
        },
      },
      'workspace_mismatch',
    ],
    ['missing source', { ...fork, source: null }, 'invalid_response'],
    [
      'missing source workspace',
      {
        ...fork,
        source: { ...fork.source, repository: { ...fork.source.repository, workspace: undefined } },
      },
      'invalid_response',
    ],
    [
      'malformed source UUID',
      {
        ...fork,
        source: { ...fork.source, repository: { ...fork.source.repository, uuid: 'fork/widgets' } },
      },
      'invalid_response',
    ],
    [
      'malformed workspace UUID',
      {
        ...fork,
        source: {
          ...fork.source,
          repository: {
            ...fork.source.repository,
            workspace: { ...fork.source.repository.workspace, uuid: '../other' },
          },
        },
      },
      'invalid_response',
    ],
    [
      'inconsistent source workspace',
      {
        ...fork,
        source: {
          ...fork.source,
          repository: {
            ...fork.source.repository,
            workspace: { ...fork.source.repository.workspace, slug: 'other' },
          },
        },
      },
      'invalid_response',
    ],
    [
      'source path traversal',
      {
        ...fork,
        source: {
          ...fork.source,
          repository: { ...fork.source.repository, full_name: 'fork/../widgets' },
        },
      },
      'invalid_response',
    ],
    [
      'reused source slug',
      {
        ...fork,
        source: {
          ...fork.source,
          repository: { ...fork.source.repository, uuid: target.repositoryUuid },
        },
      },
      'repository_mismatch',
    ],
    [
      'wrong source workspace',
      {
        ...fork,
        source: {
          ...fork.source,
          repository: {
            ...fork.source.repository,
            workspace: { ...fork.source.repository.workspace, uuid: target.workspaceUuid },
          },
        },
      },
      'workspace_mismatch',
    ],
    [
      'stale source revision',
      { ...fork, source: { ...fork.source, commit: { hash: 'b'.repeat(40) } } },
      'conflict',
    ],
    [
      'malformed provider revision',
      { ...fork, source: { ...fork.source, commit: { hash: sourceCommit.slice(0, 6) } } },
      'invalid_response',
    ],
    [
      'stale abbreviated revision',
      { ...fork, source: { ...fork.source, commit: { hash: 'b'.repeat(12) } } },
      'conflict',
    ],
    [
      'non-commit provider revision',
      { ...fork, source: { ...fork.source, commit: { hash: 'main' } } },
      'invalid_response',
    ],
  ] as const)('rejects %s without reading the source', async (_name, review, reason) => {
    providerFetch.mockImplementation(async () => Response.json(review));
    await expect(run({ ...target, request: sourceFileRequest })).resolves.toEqual({
      success: false,
      reason,
    });
    expect(providerFetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `${destinationApiPath}/pullrequests/7`,
    ]);
  });

  it.each([
    null,
    {},
    { ...sourceSelector, pullRequestId: 0 },
    { ...sourceSelector, pullRequestId: '7' },
    { ...sourceSelector, pullRequestId: Number.MAX_SAFE_INTEGER + 1 },
    { ...sourceSelector, workspaceUuid: 'fork' },
    { ...sourceSelector, repositoryUuid: '../widgets' },
    { ...sourceSelector, url: 'https://attacker.example' },
  ])('rejects a malformed source selector before provider access %#', async source => {
    await expect(run({ ...target, request: { ...sourceFileRequest, source } })).resolves.toEqual({
      success: false,
      reason: 'invalid_request',
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each(['main', sourceCommit.slice(0, 12), 'a'.repeat(39), 'a'.repeat(41), '../main', 123])(
    'rejects non-immutable commit selector %s before authorization',
    async commit => {
      await expect(
        run({
          ...target,
          request: {
            ...sourceFileRequest,
            params: { path: { ...sourceFileRequest.params.path, commit } },
          },
        })
      ).resolves.toEqual({ success: false, reason: 'invalid_request' });
      expect(providerFetch).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
    }
  );

  it.each([
    { next: 'https://attacker.example/page/2' },
    { next: `https://api.bitbucket.org${sourceApiPath}/src/${sourceCommit}/src%2Ffile.ts` },
    { body: { content: 'not-a-read' } },
    { params: { ...sourceFileRequest.params, query: { format: 'meta' } } },
  ])('rejects source next links, bodies, and query overrides %#', async change => {
    await expect(run({ ...target, request: { ...sourceFileRequest, ...change } })).resolves.toEqual(
      { success: false, reason: 'invalid_request' }
    );
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each([
    { workspace: 'fork' },
    { workspace: `{${sourceSelector.workspaceUuid}}` },
    { repo_slug: `{${sourceSelector.repositoryUuid}}` },
    { repo_slug: 'other' },
  ])('never uses a caller-selected foreign scope for the source %#', async path => {
    await expect(
      run({
        ...target,
        request: {
          ...sourceFileRequest,
          params: { path: { ...sourceFileRequest.params.path, ...path } },
        },
      })
    ).resolves.toEqual({ success: false, reason: 'repository_mismatch' });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each(['../file.ts', 'src/../file.ts', 'src\\file.ts', 'src//file.ts'])(
    'retains SDK path rejection for source file %s',
    async path => {
      await expect(
        run({
          ...target,
          request: {
            ...sourceFileRequest,
            params: { path: { ...sourceFileRequest.params.path, path } },
          },
        })
      ).resolves.toEqual({ success: false, reason: 'invalid_request' });
      expect(providerFetch.mock.calls).toHaveLength(1);
    }
  );

  it.each([
    'createComment',
    'updateComment',
    'deleteComment',
    'resolveComment',
    'reopenComment',
    'approve',
    'unapprove',
    'requestChanges',
    'removeChangeRequest',
    'merge',
    'deleteBranch',
  ])('rejects source %s even with destination-looking paths and write grants', async operation => {
    mocks.rows.mockResolvedValue([
      { ...integration, accessScopes: [...readScopes, 'pullrequest:write'] },
    ]);
    const path =
      operation === 'deleteBranch'
        ? { workspace: 'acme', repo_slug: 'widgets', name: 'feature' }
        : operation.endsWith('Comment') && operation !== 'createComment'
          ? { ...request.params.path, comment_id: 91 }
          : request.params.path;
    const body =
      operation === 'createComment' || operation === 'updateComment'
        ? { content: { raw: 'comment' } }
        : operation === 'merge'
          ? { close_source_branch: false }
          : undefined;
    for (const attempt of [
      { operation, params: { path }, body, source: sourceSelector },
      {
        operation,
        params: { path: { ...path, commit: sourceCommit } },
        source: sourceSelector,
      },
    ]) {
      await expect(run({ ...target, request: attempt })).resolves.toEqual({
        success: false,
        reason: 'invalid_request',
      });
    }
    expect(providerFetch).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    request,
    { operation: 'repository', params: { path: { workspace: 'acme', repo_slug: 'widgets' } } },
    {
      operation: 'diff',
      params: {
        path: {
          workspace: 'acme',
          repo_slug: 'widgets',
          spec: `${sourceCommit}..${'b'.repeat(40)}`,
        },
      },
    },
    {
      operation: 'commit',
      params: { path: { workspace: 'acme', repo_slug: 'widgets', commit: sourceCommit } },
    },
  ])('rejects unrelated reads with a source selector %#', async unrelated => {
    await expect(
      run({
        ...target,
        request: {
          ...unrelated,
          params: {
            ...unrelated.params,
            path: { ...unrelated.params.path, commit: sourceCommit },
          },
          source: sourceSelector,
        },
      })
    ).resolves.toEqual({ success: false, reason: 'invalid_request' });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'insufficient_permissions'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [503, 'provider_unavailable'],
    ['lost', 'transport_failed'],
    ['oversized', 'response_too_large'],
    ['redirect', 'redirect_rejected'],
  ] as const)(
    'preserves bounded source failure %s without retry or credential leakage',
    async (status, reason) => {
      providerFetch.mockResolvedValueOnce(Response.json(fork)).mockImplementation(async () => {
        if (status === 'lost') throw new Error('provider-secret');
        if (status === 'oversized')
          return new Response('provider-secret', { headers: { 'content-length': '1000001' } });
        if (status === 'redirect')
          return new Response(null, {
            status: 302,
            headers: { location: 'https://attacker.example' },
          });
        return Response.json({ error: { message: 'provider-secret' } }, { status });
      });
      const result = await run({ ...target, request: sourceFileRequest });
      expect(result).toEqual({ success: false, reason });
      expect(JSON.stringify(result)).not.toContain('provider-secret');
      expect(providerFetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'GET']);
    }
  );

  it.each(['workspace_access_token', 'oauth'])(
    'keeps %s invalidation semantics after source rejection',
    async integrationType => {
      mocks.rows.mockResolvedValue([{ ...integration, integrationType }]);
      const generations = new Map([
        [7, 'active'],
        [8, 'active'],
      ]);
      mocks.invalidate.mockImplementation(async authorization => {
        if (authorization.credentialId === integration.accessId)
          generations.set(authorization.credentialVersion, 'reconnect_required');
      });
      providerFetch
        .mockResolvedValueOnce(Response.json(fork))
        .mockResolvedValueOnce(new Response(null, { status: 401 }));
      await expect(run({ ...target, request: sourceFileRequest })).resolves.toEqual({
        success: false,
        reason: 'authentication_rejected',
      });
      expect([...generations]).toEqual([
        [7, integrationType === 'oauth' ? 'active' : 'reconnect_required'],
        [8, 'active'],
      ]);
      expect(providerFetch.mock.calls).toHaveLength(2);
    }
  );

  it('retains an empty source file instead of reporting missing content', async () => {
    providerFetch
      .mockResolvedValueOnce(Response.json(fork))
      .mockResolvedValueOnce(new Response(''));
    await expect(run({ ...target, request: sourceFileRequest })).resolves.toMatchObject({
      success: true,
      result: { status: 200, data: '' },
    });
  });

  it('leaves file calls without a selector on the destination', async () => {
    providerFetch.mockImplementation(
      async url =>
        new Response(
          new URL(String(url)).pathname ===
            `${destinationApiPath}/src/${sourceCommit}/src%2Ffile.ts`
            ? 'destination content'
            : 'wrong repository'
        )
    );
    await expect(
      run({ ...target, request: { operation: 'file', params: sourceFileRequest.params } })
    ).resolves.toMatchObject({ success: true, result: { data: 'destination content' } });
    expect(providerFetch.mock.calls).toHaveLength(1);
  });
});
