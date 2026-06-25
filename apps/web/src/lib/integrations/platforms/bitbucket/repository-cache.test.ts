/* eslint-disable drizzle/enforce-delete-with-where */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { Organization, User } from '@kilocode/db/schema';
import {
  kilocode_users,
  organizations,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import type { BitbucketRepositoryListResult } from './token-service-client';
import type {
  listBitbucketRepositories as ListBitbucketRepositories,
  primeBitbucketRepositoryCache as PrimeBitbucketRepositoryCache,
} from './repository-cache';

const mockFetchBitbucketRepositoriesFromTokenService =
  jest.fn<
    (kiloUserId: string, organizationId?: string) => Promise<BitbucketRepositoryListResult>
  >();

jest.mock('./token-service-client', () => ({
  fetchBitbucketRepositoriesFromTokenService: mockFetchBitbucketRepositoriesFromTokenService,
}));

let listBitbucketRepositories: typeof ListBitbucketRepositories;
let primeBitbucketRepositoryCache: typeof PrimeBitbucketRepositoryCache;

const WORKSPACE = {
  uuid: '123e4567-e89b-12d3-a456-426614174020',
  slug: 'acme',
  name: 'Acme',
};
const CACHED_AT = '2026-06-23T08:00:00.000Z';
const CACHED_REPOSITORY = {
  id: '123e4567-e89b-12d3-a456-426614174021',
  name: 'widgets',
  full_name: 'acme/widgets',
  private: true,
  default_branch: 'main',
};
const LIVE_REPOSITORY = {
  id: CACHED_REPOSITORY.id,
  workspaceUuid: WORKSPACE.uuid,
  name: CACHED_REPOSITORY.name,
  fullName: CACHED_REPOSITORY.full_name,
  private: CACHED_REPOSITORY.private,
  defaultBranch: CACHED_REPOSITORY.default_branch,
};
const REFRESHED_REPOSITORY = {
  id: '123e4567-e89b-12d3-a456-426614174022',
  workspaceUuid: WORKSPACE.uuid,
  name: 'gadgets',
  fullName: 'acme/gadgets',
  private: false,
};

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolvePromise) throw new Error('Deferred promise is not initialized');
      resolvePromise(value);
    },
  };
}

async function insertActiveIntegration(
  userId: string,
  cache: {
    repositories?: Array<typeof CACHED_REPOSITORY> | null;
    syncedAt?: string | null;
  } = {},
  organizationId?: string
) {
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: organizationId ? null : userId,
      owned_by_organization_id: organizationId ?? null,
      created_by_user_id: userId,
      platform: 'bitbucket',
      integration_type: 'oauth',
      platform_installation_id: WORKSPACE.uuid,
      platform_account_id: WORKSPACE.uuid,
      platform_account_login: WORKSPACE.slug,
      scopes: ['account', 'email', 'pullrequest', 'repository', 'repository:write', 'webhook'],
      repository_access: 'all',
      repositories: cache.repositories === undefined ? [CACHED_REPOSITORY] : cache.repositories,
      repositories_synced_at: cache.syncedAt === undefined ? CACHED_AT : cache.syncedAt,
      integration_status: 'active',
      metadata: { state: 'active', workspace: WORKSPACE },
    })
    .returning();
  if (!integration) throw new Error('Expected Bitbucket integration');
  await db.insert(platform_oauth_credentials).values({
    platform_integration_id: integration.id,
    platform: 'bitbucket',
    authorized_by_user_id: userId,
    provider_subject_id: '123e4567-e89b-12d3-a456-426614174010',
    provider_subject_login: 'bucket-user',
    access_token_encrypted: 'access-envelope',
    access_token_expires_at: '2030-01-01T00:00:00.000Z',
    refresh_token_encrypted: 'refresh-envelope',
  });
  return integration;
}

describe('Bitbucket repository cache', () => {
  let user: User;
  let organization: Organization;

  beforeAll(async () => {
    ({ listBitbucketRepositories, primeBitbucketRepositoryCache } =
      await import('./repository-cache'));
    user = await insertTestUser();
    organization = await createTestOrganization('Bitbucket Cache Org', user.id, 0);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await db.delete(platform_oauth_credentials);
    await db.delete(platform_integrations);
  });

  afterAll(async () => {
    await db.delete(organizations);
    await db.delete(kilocode_users);
  });

  it('returns an initialized repository cache without calling Bitbucket', async () => {
    await insertActiveIntegration(user.id);

    await expect(
      listBitbucketRepositories({
        owner: { type: 'user', id: user.id },
        kiloUserId: user.id,
      })
    ).resolves.toEqual({
      status: 'available',
      repositories: [
        {
          id: CACHED_REPOSITORY.id,
          workspaceUuid: WORKSPACE.uuid,
          name: CACHED_REPOSITORY.name,
          fullName: CACHED_REPOSITORY.full_name,
          private: true,
          defaultBranch: CACHED_REPOSITORY.default_branch,
        },
      ],
      syncedAt: CACHED_AT,
    });
    expect(mockFetchBitbucketRepositoriesFromTokenService).not.toHaveBeenCalled();
  });

  it('treats an empty synchronized repository list as an initialized cache', async () => {
    await insertActiveIntegration(user.id, { repositories: [] });

    await expect(
      listBitbucketRepositories({
        owner: { type: 'user', id: user.id },
        kiloUserId: user.id,
      })
    ).resolves.toEqual({
      status: 'available',
      repositories: [],
      syncedAt: CACHED_AT,
    });
    expect(mockFetchBitbucketRepositoriesFromTokenService).not.toHaveBeenCalled();
  });

  it('fetches and persists repositories when the cache is uninitialized', async () => {
    const integration = await insertActiveIntegration(user.id, {
      repositories: null,
      syncedAt: null,
    });
    mockFetchBitbucketRepositoriesFromTokenService.mockResolvedValue({
      status: 'available',
      repositories: [LIVE_REPOSITORY],
    });

    await expect(
      listBitbucketRepositories({
        owner: { type: 'user', id: user.id },
        kiloUserId: user.id,
      })
    ).resolves.toMatchObject({
      status: 'available',
      repositories: [LIVE_REPOSITORY],
      syncedAt: expect.any(String),
    });
    expect(mockFetchBitbucketRepositoriesFromTokenService).toHaveBeenCalledWith(user.id, undefined);

    const [updated] = await db
      .select({
        repositories: platform_integrations.repositories,
        syncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(updated).toMatchObject({
      repositories: [CACHED_REPOSITORY],
      syncedAt: expect.any(String),
    });
  });

  it('isolates organization cache misses and forwards the organization owner', async () => {
    await insertActiveIntegration(user.id);
    const integration = await insertActiveIntegration(
      user.id,
      { repositories: null, syncedAt: null },
      organization.id
    );
    mockFetchBitbucketRepositoriesFromTokenService.mockResolvedValue({
      status: 'available',
      repositories: [LIVE_REPOSITORY],
    });

    await expect(
      listBitbucketRepositories({
        owner: { type: 'org', id: organization.id },
        kiloUserId: user.id,
      })
    ).resolves.toMatchObject({
      status: 'available',
      repositories: [LIVE_REPOSITORY],
    });
    expect(mockFetchBitbucketRepositoriesFromTokenService).toHaveBeenCalledWith(
      user.id,
      organization.id
    );

    const [updated] = await db
      .select({ repositories: platform_integrations.repositories })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(updated?.repositories).toEqual([CACHED_REPOSITORY]);
  });

  it('primes an uninitialized repository cache through the real cache boundary', async () => {
    const integration = await insertActiveIntegration(user.id, {
      repositories: null,
      syncedAt: null,
    });
    mockFetchBitbucketRepositoriesFromTokenService.mockResolvedValue({
      status: 'available',
      repositories: [LIVE_REPOSITORY],
    });

    await primeBitbucketRepositoryCache({
      owner: { type: 'user', id: user.id },
      kiloUserId: user.id,
      integrationId: integration.id,
    });

    const [updated] = await db
      .select({
        repositories: platform_integrations.repositories,
        syncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(updated?.repositories).toEqual([CACHED_REPOSITORY]);
    expect(updated?.syncedAt).toBeTruthy();
  });

  it('replaces an initialized cache when refresh is forced', async () => {
    const integration = await insertActiveIntegration(user.id);
    mockFetchBitbucketRepositoriesFromTokenService.mockResolvedValue({
      status: 'available',
      repositories: [REFRESHED_REPOSITORY],
    });

    await expect(
      listBitbucketRepositories({
        owner: { type: 'user', id: user.id },
        kiloUserId: user.id,
        forceRefresh: true,
      })
    ).resolves.toMatchObject({
      status: 'available',
      repositories: [REFRESHED_REPOSITORY],
    });

    const [updated] = await db
      .select({ repositories: platform_integrations.repositories })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(updated?.repositories).toEqual([
      {
        id: REFRESHED_REPOSITORY.id,
        name: REFRESHED_REPOSITORY.name,
        full_name: REFRESHED_REPOSITORY.fullName,
        private: REFRESHED_REPOSITORY.private,
      },
    ]);
  });

  it('prevents a slower overlapping refresh from overwriting the winning cache', async () => {
    const integration = await insertActiveIntegration(user.id);
    const firstResponse = deferred<BitbucketRepositoryListResult>();
    const secondResponse = deferred<BitbucketRepositoryListResult>();
    const bothRequestsStarted = deferred<void>();
    let requestCount = 0;
    mockFetchBitbucketRepositoriesFromTokenService.mockImplementation(() => {
      requestCount += 1;
      if (requestCount === 2) bothRequestsStarted.resolve();
      return requestCount === 1 ? firstResponse.promise : secondResponse.promise;
    });

    const firstRefresh = listBitbucketRepositories({
      owner: { type: 'user', id: user.id },
      kiloUserId: user.id,
      forceRefresh: true,
    });
    const secondRefresh = listBitbucketRepositories({
      owner: { type: 'user', id: user.id },
      kiloUserId: user.id,
      forceRefresh: true,
    });
    await bothRequestsStarted.promise;

    secondResponse.resolve({ status: 'available', repositories: [REFRESHED_REPOSITORY] });
    await expect(secondRefresh).resolves.toMatchObject({
      status: 'available',
      repositories: [REFRESHED_REPOSITORY],
    });
    firstResponse.resolve({ status: 'available', repositories: [LIVE_REPOSITORY] });
    await expect(firstRefresh).resolves.toMatchObject({
      status: 'available',
      repositories: [REFRESHED_REPOSITORY],
    });

    const [updated] = await db
      .select({ repositories: platform_integrations.repositories })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(updated?.repositories).toEqual([
      {
        id: REFRESHED_REPOSITORY.id,
        name: REFRESHED_REPOSITORY.name,
        full_name: REFRESHED_REPOSITORY.fullName,
        private: REFRESHED_REPOSITORY.private,
      },
    ]);
  });

  it('preserves an initialized cache when a forced refresh is temporarily unavailable', async () => {
    const integration = await insertActiveIntegration(user.id);
    mockFetchBitbucketRepositoriesFromTokenService.mockResolvedValue({
      status: 'temporarily_unavailable',
    });

    await expect(
      listBitbucketRepositories({
        owner: { type: 'user', id: user.id },
        kiloUserId: user.id,
        forceRefresh: true,
      })
    ).resolves.toEqual({ status: 'temporarily_unavailable' });

    const [unchanged] = await db
      .select({
        repositories: platform_integrations.repositories,
        syncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(unchanged?.repositories).toEqual([CACHED_REPOSITORY]);
    expect(new Date(unchanged?.syncedAt ?? '').toISOString()).toBe(CACHED_AT);
  });
});
