import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type * as TokenModule from './token-service-client';
import type * as CacheModule from './repository-cache';
import type * as OAuthModule from './oauth-integration';
import type * as WorkspaceModule from './workspace-access-token-repository-cache';

jest.mock('@/lib/config.server', () => ({
  GIT_TOKEN_SERVICE_API_URL: 'https://token-service.test',
}));
jest.mock('@/lib/tokens', () => ({
  generateInternalServiceToken: () => 'test-token',
  TOKEN_EXPIRY: { fiveMinutes: 300 },
  BITBUCKET_REPOSITORY_LIST_AUDIENCE: 'repositories',
}));
jest.mock('@/lib/drizzle', () => ({ db: {} }));
jest.mock('next/server', () => ({ after: jest.fn() }));
jest.mock('./workspace-access-token-organization-authorization', () => ({}));

let token: typeof TokenModule;
let cache: typeof CacheModule;
let oauth: typeof OAuthModule;
let workspace: typeof WorkspaceModule;
beforeAll(async () => {
  token = await import('./token-service-client');
  cache = await import('./repository-cache');
  oauth = await import('./oauth-integration');
  workspace = await import('./workspace-access-token-repository-cache');
});
const repository = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceUuid: '22222222-2222-4222-8222-222222222222',
  name: 'API',
  fullName: 'acme/API',
  private: true,
};
const owner = { type: 'org' as const, id: '33333333-3333-4333-8333-333333333333' };
const integrationId = '44444444-4444-4444-8444-444444444444';
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe.each(['token service', 'OAuth cache', 'organization', 'workspace cache'] as const)(
  '%s repository wire contract',
  name => {
    const timestamps = name === 'token service' ? {} : { syncedAt: '2026-08-29T00:00:00.000Z' };
    const getSchema = () =>
      name === 'token service'
        ? token.BitbucketRepositoryListResultSchema
        : name === 'OAuth cache'
          ? cache.CachedBitbucketRepositoryListResultSchema
          : name === 'organization'
            ? oauth.BitbucketOrganizationRepositoryListResultSchema
            : workspace.BitbucketWorkspaceAccessTokenRepositoryListResultSchema;

    it('accepts serialized old rows without inventing a default or integration', () => {
      const payload = JSON.parse(
        JSON.stringify({ status: 'available', repositories: [repository], ...timestamps })
      );
      expect(getSchema().parse(payload)).toEqual(payload);
    });
    it('retains the producing integration and normalized nullable default', () => {
      const row = token.withBitbucketRepositoryIdentity(repository, owner, integrationId);
      const result = getSchema().parse(
        JSON.parse(JSON.stringify({ status: 'available', repositories: [row], ...timestamps }))
      );
      expect(result).toMatchObject({
        repositories: [
          {
            id: repository.id,
            platformIntegrationId: integrationId,
            repositoryReference: {
              repository: {
                provider: 'bitbucket',
                instanceUrl: 'https://bitbucket.org',
                repositoryId: repository.id,
                workspaceUuid: repository.workspaceUuid,
                fullName: 'acme/API',
                defaultBranch: null,
              },
              authorization: { kind: 'ownerIntegration', owner, integrationId },
            },
          },
        ],
      });
    });
    it.each([
      ['unknown field', { ...repository, token: 'must-not-escape' }],
      ['malformed integration', { ...repository, platformIntegrationId: 'invalid' }],
      ['wrong host', { ...repository, instanceUrl: 'https://attacker.test' }],
    ])('rejects %s instead of weakening strict parsing', (_label, row) => {
      expect(
        getSchema().safeParse({ status: 'available', repositories: [row], ...timestamps }).success
      ).toBe(false);
    });
    it('rejects a normalized reference for a different repository', () => {
      const row = {
        ...token.withBitbucketRepositoryIdentity(repository, owner, integrationId),
        id: owner.id,
      };
      expect(
        getSchema().safeParse({ status: 'available', repositories: [row], ...timestamps }).success
      ).toBe(false);
    });
  }
);

describe('Bitbucket discovery transport', () => {
  it.each([
    'insufficient_permissions',
    'invalid_request',
    'temporarily_unavailable',
    'not_connected',
  ] as const)('preserves %s without an empty-success substitution', async status => {
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue(Response.json({ status }));
    await expect(
      token.fetchBitbucketRepositoriesFromTokenService('oauth/user', owner.id)
    ).resolves.toEqual({ status });
  });
  it('returns a retryable failure for malformed provider JSON', async () => {
    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ status: 'available', repositories: [{ ...repository, id: 12 }] })
      );
    await expect(
      token.fetchBitbucketRepositoriesFromTokenService('oauth/user', owner.id)
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
  });
});
