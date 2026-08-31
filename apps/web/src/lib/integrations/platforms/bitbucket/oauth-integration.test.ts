import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  createBitbucketInteractiveApi,
  type BitbucketInteractiveRequest,
} from '../../../../../../../services/git-token-service/src/bitbucket-interactive-api';
import {
  BitbucketApiError,
  BitbucketInteractiveError,
} from '../../../../../../../services/git-token-service/src/bitbucket-safe-transport';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_UUID = '33333333-3333-4333-8333-333333333333';
const REPOSITORY_UUID = '44444444-4444-4444-8444-444444444444';
const REPLACEMENT_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = 'oauth/actor';
const OWNER = { type: 'org' as const, id: ORGANIZATION_ID };
const TIMESTAMP = '2026-08-29 01:02:03.123+00';
const cachedRepository = {
  id: REPOSITORY_UUID,
  name: 'API',
  full_name: 'acme/API',
  private: true,
  default_branch: 'release/Case',
};
const repository = {
  id: REPOSITORY_UUID,
  workspaceUuid: WORKSPACE_UUID,
  name: 'API',
  fullName: 'acme/API',
  private: true,
  defaultBranch: 'release/Case',
};
const mockRows: unknown[][] = [];
const mockUpdateRows: unknown[][] = [];
const writes: Record<string, unknown>[] = [];

function query() {
  const result: Record<string, unknown> = {
    from: () => result,
    leftJoin: () => result,
    innerJoin: () => result,
    where: () => result,
    limit: async () => mockRows.shift() ?? [],
    then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(mockRows.shift() ?? []).then(resolve, reject),
  };
  return result;
}
const mockDb: { select: jest.Mock; update: jest.Mock; transaction: jest.Mock } = {
  select: jest.fn(query),
  update: jest.fn(() => ({
    set: (value: Record<string, unknown>) => {
      writes.push(value);
      return {
        where: () => ({
          returning: async () => mockUpdateRows.shift() ?? [{ id: INTEGRATION_ID }],
        }),
      };
    },
  })),
  transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(mockDb)),
};

jest.mock('@/lib/drizzle', () => ({ db: mockDb }));
jest.mock('@/lib/config.server', () => ({
  GIT_TOKEN_SERVICE_API_URL: 'https://token-service.test',
}));
jest.mock('@/lib/tokens', () => ({
  generateInternalServiceToken: () => 'test-token',
  TOKEN_EXPIRY: { fiveMinutes: 300 },
  BITBUCKET_REPOSITORY_LIST_AUDIENCE: 'repositories',
}));
jest.mock('next/server', () => ({ after: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('./workspace-access-token-organization-authorization', () => ({
  lockBitbucketWorkspaceAccessTokenOrganization: async () => undefined,
  requireBitbucketWorkspaceAccessTokenOrganizationManager: async () => undefined,
  BitbucketWorkspaceAccessTokenOrganizationAuthorizationError: class extends Error {},
}));

function oauthRow(integrationId = INTEGRATION_ID) {
  return {
    integrationId,
    integrationStatus: 'active',
    installationId: WORKSPACE_UUID,
    accountId: WORKSPACE_UUID,
    accountLogin: 'acme',
    metadata: { state: 'active', workspace: { uuid: WORKSPACE_UUID, slug: 'acme', name: 'Acme' } },
    repositories: [cachedRepository],
    repositoriesSyncedAt: TIMESTAMP,
    nickname: 'provider-user',
    credentialId: 'credential',
    revokedAt: null,
    credential: {
      id: 'credential',
      platform_integration_id: integrationId,
      authorized_by_user_id: USER_ID,
      provider_subject_id: 'provider-user-id',
      provider_subject_login: 'provider-user',
      provider_base_url: null,
      access_token_encrypted: 'encrypted',
      access_token_expires_at: null,
      refresh_token_encrypted: 'encrypted-refresh',
      refresh_token_expires_at: null,
      oauth_client_secret_encrypted: null,
      credential_version: 1,
      revoked_at: null,
      revocation_reason: null,
      last_used_at: null,
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
    },
  };
}
function workspaceRow(integrationId = INTEGRATION_ID) {
  return {
    integrationId,
    integrationStatus: 'active',
    installationId: null,
    workspaceUuid: WORKSPACE_UUID,
    workspaceSlug: 'acme',
    metadata: { displayName: 'Acme' },
    repositories: [cachedRepository],
    repositoriesSyncedAt: TIMESTAMP,
    authInvalidAt: null,
    authInvalidReason: null,
    credential: {
      id: 'credential',
      platform_integration_id: integrationId,
      token_encrypted: 'encrypted',
      expires_at: null,
      provider_credential_type: 'workspace_access_token',
      provider_resource_id: null,
      provider_base_url: null,
      authorized_by_user_id: null,
      provider_metadata: null,
      provider_scopes: ['account', 'repository', 'repository:write', 'pullrequest', 'webhook'],
      provider_verified_at: TIMESTAMP,
      credential_version: 1,
      last_validated_at: TIMESTAMP,
      last_used_at: null,
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
    },
  };
}

import type * as OAuthModule from './oauth-integration';
import type * as CacheModule from './repository-cache';
import type * as WorkspaceModule from './workspace-access-token-repository-cache';
import type * as TokenModule from './token-service-client';

let oauth: typeof OAuthModule;
let cache: typeof CacheModule;
let workspace: typeof WorkspaceModule;
let token: typeof TokenModule;
const originalFetch = global.fetch;
beforeAll(async () => {
  oauth = await import('./oauth-integration');
  cache = await import('./repository-cache');
  workspace = await import('./workspace-access-token-repository-cache');
  token = await import('./token-service-client');
});
beforeEach(() => {
  mockRows.length = 0;
  mockUpdateRows.length = 0;
  writes.length = 0;
  global.fetch = jest
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ status: 'available', repositories: [repository] }));
});
afterEach(() => {
  global.fetch = originalFetch;
});

function expectIdentity(value: unknown, integrationId = INTEGRATION_ID) {
  expect(value).toMatchObject({
    status: 'available',
    repositories: [
      {
        platformIntegrationId: integrationId,
        repositoryReference: {
          repository: {
            provider: 'bitbucket',
            instanceUrl: 'https://bitbucket.org',
            repositoryId: REPOSITORY_UUID,
            workspaceUuid: WORKSPACE_UUID,
            fullName: 'acme/API',
            defaultBranch: 'release/Case',
          },
          authorization: { kind: 'ownerIntegration', owner: OWNER, integrationId },
        },
      },
    ],
  });
}

describe('Bitbucket discovery producer identity', () => {
  it('normalizes an old OAuth cache row in the producing lookup', async () => {
    mockRows.push([oauthRow()]);
    const result = await cache.listBitbucketRepositories({ owner: OWNER, kiloUserId: USER_ID });
    expectIdentity(result);
    expect(result).toMatchObject({ syncedAt: '2026-08-29T01:02:03.123Z' });
  });
  it('normalizes an old workspace cache row in the producing lookup', async () => {
    mockRows.push([workspaceRow()]);
    expectIdentity(
      await workspace.readCachedBitbucketWorkspaceAccessTokenRepositories({
        organizationId: ORGANIZATION_ID,
      })
    );
  });
  it('retains identity in the OAuth status cache projection', async () => {
    mockRows.push([oauthRow()]);
    const result = await oauth.getBitbucketOAuthIntegrationStatus(OWNER, true);
    expectIdentity(result?.repositoryCache);
  });
  it('retains identity in the workspace status cache projection', async () => {
    mockRows.push([workspaceRow()]);
    const result = await workspace.getBitbucketWorkspaceAccessTokenStatus(ORGANIZATION_ID);
    expectIdentity(result.repositoryCache);
  });
  it('returns fresh OAuth identity while storing only the old cache row shape', async () => {
    mockRows.push([oauthRow()]);
    expectIdentity(
      await cache.listBitbucketRepositories({
        owner: OWNER,
        kiloUserId: USER_ID,
        forceRefresh: true,
      })
    );
    expect(writes[0].repositories).toEqual([cachedRepository]);
  });
  it('returns fresh workspace identity while storing only the old cache row shape', async () => {
    mockRows.push(
      [workspaceRow()],
      [{ integrationId: INTEGRATION_ID, credentialId: 'credential', credentialVersion: 1 }]
    );
    expectIdentity(
      await workspace.refreshBitbucketWorkspaceAccessTokenRepositories({
        organizationId: ORGANIZATION_ID,
        kiloUserId: USER_ID,
        expectedIntegrationId: INTEGRATION_ID,
      })
    );
    expect(writes[0].repositories).toEqual([cachedRepository]);
  });
  it('labels a replacement OAuth cache with the replacement identity, not the stale lookup', async () => {
    mockRows.push([oauthRow()], [oauthRow(REPLACEMENT_ID)]);
    mockUpdateRows.push([]);
    expectIdentity(
      await cache.listBitbucketRepositories({
        owner: OWNER,
        kiloUserId: USER_ID,
        forceRefresh: true,
      }),
      REPLACEMENT_ID
    );
  });
  it('does not drop an explicit OAuth pin after a replacement race', async () => {
    mockRows.push([oauthRow()], [oauthRow(REPLACEMENT_ID)]);
    mockUpdateRows.push([]);
    await expect(
      cache.listBitbucketRepositories({
        owner: OWNER,
        kiloUserId: USER_ID,
        forceRefresh: true,
        expectedIntegrationId: INTEGRATION_ID,
      })
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
  });
  it('labels a replacement workspace cache with the winning identity', async () => {
    mockRows.push(
      [workspaceRow()],
      [
        {
          integrationId: REPLACEMENT_ID,
          credentialId: 'replacement-credential',
          credentialVersion: 1,
        },
      ],
      [workspaceRow(REPLACEMENT_ID)]
    );
    expectIdentity(
      await workspace.refreshBitbucketWorkspaceAccessTokenRepositories({
        organizationId: ORGANIZATION_ID,
        kiloUserId: USER_ID,
        expectedIntegrationId: INTEGRATION_ID,
      }),
      REPLACEMENT_ID
    );
    expect(writes).toEqual([]);
  });
  it('keeps an unavailable default nullable in old cache rows', async () => {
    const row = oauthRow();
    mockRows.push([
      {
        ...row,
        repositories: [{ id: REPOSITORY_UUID, name: 'API', full_name: 'acme/API', private: true }],
      },
    ]);
    const result = await cache.listBitbucketRepositories({ owner: OWNER, kiloUserId: USER_ID });
    expect(result).toMatchObject({
      repositories: [{ repositoryReference: { repository: { defaultBranch: null } } }],
    });
  });
  it('distinguishes an initialized empty cache from a missing integration', async () => {
    mockRows.push([{ ...oauthRow(), repositories: [] }], []);
    await expect(
      cache.listBitbucketRepositories({ owner: OWNER, kiloUserId: USER_ID })
    ).resolves.toEqual({
      status: 'available',
      repositories: [],
      syncedAt: '2026-08-29T01:02:03.123Z',
    });
    await expect(
      cache.listBitbucketRepositories({ owner: OWNER, kiloUserId: USER_ID })
    ).resolves.toEqual({ status: 'not_connected' });
  });
  it('preserves cached rows when a provider refresh fails', async () => {
    mockRows.push([oauthRow()], [oauthRow()]);
    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: 'temporarily_unavailable' }));
    await expect(
      cache.listBitbucketRepositories({ owner: OWNER, kiloUserId: USER_ID, forceRefresh: true })
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
    expectIdentity(await cache.listBitbucketRepositories({ owner: OWNER, kiloUserId: USER_ID }));
    expect(writes).toEqual([]);
  });
  it('rejects a stale workspace pin without substituting a same-name repository', async () => {
    mockRows.push([workspaceRow(REPLACEMENT_ID)]);
    await expect(
      workspace.readCachedBitbucketWorkspaceAccessTokenRepositories({
        organizationId: ORGANIZATION_ID,
        expectedIntegrationId: INTEGRATION_ID,
      })
    ).resolves.toEqual({ status: 'invalid_request' });
  });
});

function useInteractiveService(providerFetch: typeof fetch) {
  const api = createBitbucketInteractiveApi({
    scope: { kind: 'repository', workspace: 'acme', repository: 'API' },
    accessToken: 'provider-test-token',
    fetch: providerFetch,
  });
  global.fetch = jest.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      request: BitbucketInteractiveRequest<'branches'>;
    };
    try {
      return Response.json({
        success: true,
        result: await api.execute(body.request),
        metadata: {
          actorUserId: USER_ID,
          organizationId: ORGANIZATION_ID,
          integrationId: INTEGRATION_ID,
          instanceUrl: 'https://bitbucket.org',
          providerActor: {
            credentialKind: 'bitbucketWorkspaceToken',
            workspaceUuid: WORKSPACE_UUID,
            workspaceSlug: 'acme',
          },
          grants: { scopes: ['repository', 'pullrequest'] },
        },
      });
    } catch (error) {
      if (!(error instanceof BitbucketApiError || error instanceof BitbucketInteractiveError))
        throw error;
      return Response.json({ success: false, reason: error.code });
    }
  });
}
function branchesInput(defaultBranch: string | undefined = 'release/Case') {
  return {
    actorUserId: USER_ID,
    organizationId: ORGANIZATION_ID,
    reference: token.withBitbucketRepositoryIdentity(
      { ...repository, defaultBranch },
      OWNER,
      INTEGRATION_ID
    ).repositoryReference,
  };
}

describe('Bitbucket branch boundary through the b1/a3 transport', () => {
  const next =
    'https://api.bitbucket.org/2.0/repositories/acme/API/refs/branches?pagelen=50&page=2';
  it('uses the supported request with transport pagination and the selected default', async () => {
    const providerFetch = jest.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        values: [{ name: 'release/Case' }, { name: 'feature/Case' }],
        pagelen: 50,
        next,
      })
    );
    useInteractiveService(providerFetch);
    await expect(oauth.listBitbucketRepositoryBranches(branchesInput())).resolves.toEqual({
      branches: [
        { name: 'release/Case', isDefault: true },
        { name: 'feature/Case', isDefault: false },
      ],
      defaultBranch: 'release/Case',
      nextCursor: next,
    });
    expect(JSON.parse(String(jest.mocked(global.fetch).mock.calls[0][1]?.body))).toEqual({
      integrationId: INTEGRATION_ID,
      workspaceUuid: WORKSPACE_UUID,
      workspaceSlug: 'acme',
      repositoryUuid: REPOSITORY_UUID,
      repositoryFullName: 'acme/API',
      request: {
        operation: 'branches',
        params: { path: { workspace: 'acme', repo_slug: 'API' } },
      },
    });
    expect(providerFetch.mock.calls[0][0]).toBe(
      'https://api.bitbucket.org/2.0/repositories/acme/API/refs/branches?pagelen=50'
    );
  });
  it('preserves the first page while a failed page can be retried', async () => {
    let pageCalls = 0;
    useInteractiveService(
      jest.fn<typeof fetch>(async url => {
        if (!String(url).includes('page=2'))
          return Response.json({ values: [{ name: 'release/Case' }], next });
        pageCalls += 1;
        return pageCalls === 1
          ? new Response('', { status: 503 })
          : Response.json({ values: [{ name: 'feature/retry' }] });
      })
    );
    const input = branchesInput();
    const first = await oauth.listBitbucketRepositoryBranches(input);
    await expect(
      oauth.listBitbucketRepositoryBranches({ ...input, cursor: next })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(
      oauth.listBitbucketRepositoryBranches({ ...input, cursor: next })
    ).resolves.toMatchObject({
      branches: [{ name: 'feature/retry', isDefault: false }],
      nextCursor: null,
    });
    expect(first).toEqual({
      branches: [{ name: 'release/Case', isDefault: true }],
      defaultBranch: 'release/Case',
      nextCursor: next,
    });
  });
  it.each([
    'https://attacker.test/branches?page=2',
    'https://api.bitbucket.org/2.0/repositories/other/API/refs/branches?pagelen=50&page=2',
  ])('rejects an out-of-scope next URL: %s', async invalidNext => {
    useInteractiveService(
      jest.fn<typeof fetch>().mockResolvedValue(Response.json({ values: [], next: invalidNext }))
    );
    await expect(oauth.listBitbucketRepositoryBranches(branchesInput())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
  it('does not guess a default in an empty repository', async () => {
    useInteractiveService(jest.fn<typeof fetch>().mockResolvedValue(Response.json({ values: [] })));
    const input = branchesInput();
    input.reference.repository.defaultBranch = null;
    await expect(oauth.listBitbucketRepositoryBranches(input)).resolves.toEqual({
      branches: [],
      defaultBranch: null,
      nextCursor: null,
    });
  });
  it('does not treat a branch named main as an unknown default', async () => {
    useInteractiveService(
      jest.fn<typeof fetch>().mockResolvedValue(Response.json({ values: [{ name: 'main' }] }))
    );
    const input = branchesInput();
    input.reference.repository.defaultBranch = null;
    await expect(oauth.listBitbucketRepositoryBranches(input)).resolves.toMatchObject({
      branches: [{ name: 'main', isDefault: false }],
      defaultBranch: null,
    });
  });
  it('rejects a different owner before requesting provider branches', async () => {
    const input = branchesInput();
    input.reference.authorization.owner = { type: 'user', id: USER_ID };
    await expect(oauth.listBitbucketRepositoryBranches(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('distinguishes denied provider access from a retryable page failure', async () => {
    useInteractiveService(
      jest.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 }))
    );
    await expect(oauth.listBitbucketRepositoryBranches(branchesInput())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
