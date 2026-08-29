import { getWorkerDb } from '@kilocode/db/client';
import type * as DbClientModule from '@kilocode/db/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BitbucketRuntimeTokenResolverModule from './bitbucket-runtime-token-resolver.js';
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
const fork = {
  id: 7,
  source: {
    repository: { uuid: '{123e4567-e89b-12d3-a456-426614174099}', full_name: 'fork/widgets' },
  },
  destination: { repository: { uuid: `{${target.repositoryUuid}}` } },
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
