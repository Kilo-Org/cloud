/**
 * @jest-environment node
 */
import { describe, expect, it, beforeAll, beforeEach } from '@jest/globals';
// @swc/jest only hoists `jest.mock` calls when `jest` is the GLOBAL binding
// (@types/jest). Importing `jest` from '@jest/globals' defeats hoisting: the
// mocked modules load for real before registration. Same pattern as
// github-pr-review-router.test.ts.
import type * as TrpcInitModule from '@/lib/trpc/init';
import type * as OrganizationUtilsModule from '@/routers/organizations/utils';
import type * as ZodModule from 'zod';
import { createCallerFactory } from '@/lib/trpc/init';
import type { User } from '@kilocode/db/schema';
import { BitbucketReviewError } from '@/lib/provider-review/bitbucket-authorization';
import { organizationCloudAgentNextRouter } from './organization-cloud-agent-next-router';

const ORG_ID = '9a283301-b75d-4375-a1ba-e319a02e18b7';
const USER_ID = 'user-1';

// ----- mocked seams (all factories delegate lazily) ----------------------------

// The global `jest` binding comes from @types/jest, whose `fn` takes either no
// type arguments or the (return, args) pair — not the single function type that
// `@jest/globals`' `jest.fn` accepts. We cannot import `jest` here without
// breaking @swc/jest hoisting, so spell the pair out.
const mockEnsureOrganizationAccess = jest.fn<
  ReturnType<typeof OrganizationUtilsModule.ensureOrganizationAccess>,
  Parameters<typeof OrganizationUtilsModule.ensureOrganizationAccess>
>();

jest.mock('@/routers/organizations/utils', () => {
  const trpcInit = jest.requireActual<typeof TrpcInitModule>('@/lib/trpc/init');
  const zod = jest.requireActual<typeof ZodModule>('zod');
  const organizationProcedure = trpcInit.baseProcedure
    .input(zod.object({ organizationId: zod.uuid() }))
    .use(async ({ ctx, input, next }: any) => {
      await mockEnsureOrganizationAccess(ctx, input.organizationId);
      return next();
    });
  return {
    ...jest.requireActual<typeof OrganizationUtilsModule>('@/routers/organizations/utils'),
    // Lazy delegation: the factory runs while the router module is being
    // required (during the hoisted-import phase), before the const above is
    // initialized. Reading it eagerly throws a TDZ ReferenceError.
    ensureOrganizationAccess: (...args: unknown[]) =>
      mockEnsureOrganizationAccess(...(args as Parameters<typeof mockEnsureOrganizationAccess>)),
    organizationMemberProcedure: organizationProcedure,
    organizationMemberMutationProcedure: organizationProcedure,
  };
});

// The org router's heavy runtime deps, mocked exactly as the existing
// organization-cloud-agent-next-router.test.ts does.
jest.mock('@/lib/tokens', () => ({
  generateCloudAgentToken: jest.fn(() => 'cloud-agent-token'),
  generateInternalServiceToken: jest.fn(),
  TOKEN_EXPIRY: 60,
}));
jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(),
  createCloudAgentNextClientForModel: jest.fn(),
  rethrowAsPaymentRequired: jest.fn(),
}));
jest.mock('@/lib/cloud-agent-next/worktree-chat', () => ({ createWorktreeChat: jest.fn() }));
jest.mock('@/lib/trpc/min-version', () => ({
  ...jest.requireActual('@/lib/trpc/min-version'),
  getMinimumVersions: jest.fn(async () => ({ ios: '0.0.0', android: '0.0.0' })),
  enforceMinimumVersion: jest.fn(() => ({ pass: true })),
}));
jest.mock('@/lib/cloud-agent-next/balance-check-eligibility', () => ({
  computeCloudAgentNextBalanceCheckEligibility: jest.fn(),
}));
jest.mock('@/lib/posthog-feature-flags', () => ({
  isFeatureFlagEnabledOrDevelopment: jest.fn(async () => false),
}));
jest.mock('@/lib/organizations/organization-usage', () => ({
  getBalanceForOrganizationUser: jest.fn(),
}));
jest.mock('@/lib/cloud-agent/bitbucket-integration-helpers', () => ({
  ...jest.requireActual('@/lib/cloud-agent/bitbucket-integration-helpers'),
  fetchBitbucketRepositoriesForOrganization: jest.fn(),
}));
jest.mock('@/lib/cloud-agent/github-integration-helpers', () => ({
  fetchGitHubRepositoriesForOrganization: jest.fn(),
  fetchAllGitHubRepositoriesForOrganization: jest.fn(),
}));
jest.mock('@/lib/cloud-agent/gitlab-integration-helpers', () => ({
  buildGitLabCloneUrl: jest.fn(),
  fetchGitLabRepositoriesForOrganization: jest.fn(),
  getGitLabInstanceUrlForOrganization: jest.fn(),
}));
jest.mock('@/lib/cloud-agent/order-repositories', () => ({
  orderRepositoriesByUsage: jest.fn(async ({ repositories }: any) => repositories),
}));
jest.mock('@/lib/cloud-agent/session-ownership', () => ({
  verifyOrgOwnsSessionV2ByCloudAgentId: jest.fn(),
}));
jest.mock('@/lib/r2/cloud-agent-attachments', () => ({
  generateImageUploadUrl: jest.fn(),
  generateCloudAgentAttachmentUploadUrl: jest.fn(),
}));

// The branch listing's provider seams.
const mockGetIntegrationForOwner = jest.fn();
const mockGetIntegrationsByOrganization = jest.fn();
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (...a: unknown[]) => mockGetIntegrationForOwner(...a),
  getIntegrationsByOrganization: (...a: unknown[]) => mockGetIntegrationsByOrganization(...a),
}));

const mockListBranches = jest.fn();
jest.mock('@/lib/integrations/github-apps-service', () => ({
  listBranches: (...a: unknown[]) => mockListBranches(...a),
}));

const mockGetValidGitLabToken = jest.fn();
jest.mock('@/lib/integrations/gitlab-service', () => ({
  getValidGitLabToken: (...a: unknown[]) => mockGetValidGitLabToken(...a),
}));

const mockFetchGitLabBranches = jest.fn();
jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  ...jest.requireActual('@/lib/integrations/platforms/gitlab/adapter'),
  fetchGitLabBranches: (...a: unknown[]) => mockFetchGitLabBranches(...a),
}));

const mockAuthorizeRepository = jest.fn();
jest.mock('@/lib/provider-review/bitbucket-authorization', () => ({
  ...jest.requireActual('@/lib/provider-review/bitbucket-authorization'),
  authorizeRepository: (...a: unknown[]) => mockAuthorizeRepository(...a),
}));

const mockFetchPage = jest.fn();
const mockRequestBitbucketJson = jest.fn();
jest.mock('@/lib/provider-review/bitbucket-read', () => ({
  ...jest.requireActual('@/lib/provider-review/bitbucket-read'),
  fetchPage: (...a: unknown[]) => mockFetchPage(...a),
  requestBitbucketJson: (...a: unknown[]) => mockRequestBitbucketJson(...a),
}));

// ----- fixtures ---------------------------------------------------------------

const activeIntegration = { id: 'int-1', integration_status: 'active' };

/** An active organization GitLab integration whose cache lists the project. */
const gitlabIntegration = {
  id: 'int-1',
  integration_status: 'active',
  metadata: { gitlab_instance_url: 'https://gitlab.example.com' },
  repositories: [{ id: 7, name: 'proj', full_name: 'group/proj', private: true }],
};

/** A healthy organization-owned GitHub installation row with its repository cache. */
const githubInstallation = (id: string, repositoryFullNames: string[]) => ({
  id,
  integration_status: 'active',
  suspended_at: null,
  auth_invalid_at: null,
  repositories: repositoryFullNames.map((full_name, index) => ({ id: index + 1, full_name })),
});

/** The refusal GitHub returns for a repository an installation cannot see. */
const notVisible = () => Object.assign(new Error('Not Found'), { status: 404 });

/** The access the authorization layer returns — server-derived identity. */
const bitbucketAccess = {
  accessToken: 'workspace-token',
  workspace: { uuid: '{ws-uuid}', slug: 'Acme' },
  repository: { uuid: '{repo-uuid}', slug: 'Widgets', fullName: 'Acme/Widgets' },
  owner: { type: 'organization', organizationId: ORG_ID, userId: USER_ID },
};

let caller: any;

beforeAll(() => {
  caller = createCallerFactory(organizationCloudAgentNextRouter)({
    user: { id: USER_ID, is_admin: false } as User,
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  // Reset the bitbucket queue mocks so no leftover once-implementations can
  // leak between tests, then define the default two-page walk.
  mockFetchPage.mockReset();
  mockRequestBitbucketJson.mockReset();
  mockEnsureOrganizationAccess.mockResolvedValue('member');
  mockGetIntegrationForOwner.mockResolvedValue(activeIntegration);
  mockGetIntegrationsByOrganization.mockResolvedValue([
    githubInstallation('int-1', ['octocat/hello']),
  ]);
  mockListBranches.mockResolvedValue({
    branches: [
      { name: 'main', isDefault: true },
      { name: 'feature/x', isDefault: false },
    ],
  });
  mockGetValidGitLabToken.mockResolvedValue('glpat-mock-token');
  mockFetchGitLabBranches.mockResolvedValue([
    { name: 'dev', default: true, protected: true },
    { name: 'release', default: false, protected: false },
  ]);
  mockAuthorizeRepository.mockResolvedValue(bitbucketAccess);
  // The real `GET /2.0/repositories/{workspace}/{slug}` payload: the default
  // branch is `mainbranch.name` — the same field every other Bitbucket
  // adapter in this codebase reads (bitbucket-api.ts, workspace-access-token-
  // adapter.ts). Extra provider fields must not break the parse.
  mockRequestBitbucketJson.mockResolvedValue({
    uuid: '{repo-uuid}',
    full_name: 'Acme/Widgets',
    mainbranch: { name: 'master' },
    branching_model: { development: { name: 'dev' }, production: { name: 'master' } },
  });
  mockFetchPage.mockImplementation(
    async (_access: unknown, _path: unknown, _id: unknown, cursor: unknown) => {
      if (cursor === undefined) {
        return {
          values: [
            { name: 'master', type: 'branch' },
            { name: 'feat', type: 'branch' },
          ],
          nextCursor: 'page-2',
        };
      }
      return {
        values: [
          { name: 'master', type: 'branch' },
          { name: 'release', type: 'branch' },
        ],
        nextCursor: null,
      };
    }
  );
});

describe('organizationCloudAgentNextRouter.listRepositoryBranches', () => {
  it('runs the organization guard before any provider call', async () => {
    mockEnsureOrganizationAccess.mockRejectedValueOnce(
      new Error('You do not have access to this organization')
    );
    await expect(
      caller.listRepositoryBranches({
        organizationId: ORG_ID,
        platform: 'github',
        repository: { fullName: 'octocat/hello' },
      })
    ).rejects.toBeDefined();
    expect(mockGetIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockGetIntegrationsByOrganization).not.toHaveBeenCalled();
    expect(mockListBranches).not.toHaveBeenCalled();
  });

  it('lists GitHub branches against the ORG-owned integration the server resolved', async () => {
    const result = await caller.listRepositoryBranches({
      organizationId: ORG_ID,
      platform: 'github',
      repository: { fullName: 'octocat/hello' },
    });
    expect(result).toEqual({ defaultBranch: 'main', branches: ['main', 'feature/x'] });
    expect(mockGetIntegrationsByOrganization).toHaveBeenCalledWith(ORG_ID, 'github');
    expect(mockListBranches).toHaveBeenCalledWith(
      { type: 'org', id: ORG_ID },
      'int-1',
      'octocat/hello'
    );
  });

  it('resolves the installation that owns the repository, not the primary row', async () => {
    // Two connected GitHub accounts: the primary (oldest) installation cannot
    // see the repository, the second one caches it.
    mockGetIntegrationsByOrganization.mockResolvedValue([
      githubInstallation('int-primary', ['other/repo']),
      githubInstallation('int-owning', ['Octocat/Hello']),
    ]);
    const result = await caller.listRepositoryBranches({
      organizationId: ORG_ID,
      platform: 'github',
      repository: { fullName: 'octocat/hello' },
    });
    expect(result).toEqual({ defaultBranch: 'main', branches: ['main', 'feature/x'] });
    expect(mockListBranches).toHaveBeenCalledTimes(1);
    expect(mockListBranches).toHaveBeenCalledWith(
      { type: 'org', id: ORG_ID },
      'int-owning',
      'octocat/hello'
    );
  });

  it('skips unhealthy installations when resolving the repository', async () => {
    mockGetIntegrationsByOrganization.mockResolvedValue([
      { ...githubInstallation('int-suspended', ['octocat/hello']), suspended_at: 'ts' },
      githubInstallation('int-healthy', ['octocat/hello']),
    ]);
    await caller.listRepositoryBranches({
      organizationId: ORG_ID,
      platform: 'github',
      repository: { fullName: 'octocat/hello' },
    });
    expect(mockListBranches).toHaveBeenCalledTimes(1);
    expect(mockListBranches.mock.calls[0][1]).toBe('int-healthy');
  });

  it('falls back to the other healthy installations when every repository cache is stale', async () => {
    mockGetIntegrationsByOrganization.mockResolvedValue([
      githubInstallation('int-primary', []),
      githubInstallation('int-second', []),
    ]);
    mockListBranches.mockRejectedValueOnce(notVisible());
    const result = await caller.listRepositoryBranches({
      organizationId: ORG_ID,
      platform: 'github',
      repository: { fullName: 'octocat/hello' },
    });
    expect(result).toEqual({ defaultBranch: 'main', branches: ['main', 'feature/x'] });
    expect(mockListBranches.mock.calls.map(call => call[1])).toEqual(['int-primary', 'int-second']);
  });

  it('refuses with a clear NOT_FOUND when no installation can see the repository', async () => {
    mockGetIntegrationsByOrganization.mockResolvedValue([
      githubInstallation('int-primary', []),
      githubInstallation('int-second', []),
    ]);
    mockListBranches.mockRejectedValue(notVisible());
    await expect(
      caller.listRepositoryBranches({
        organizationId: ORG_ID,
        platform: 'github',
        repository: { fullName: 'octocat/hello' },
      })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('not available in any connected GitHub installation'),
    });
    expect(mockListBranches).toHaveBeenCalledTimes(2);
  });

  it('surfaces a non-visibility GitHub failure instead of retrying other installations', async () => {
    mockGetIntegrationsByOrganization.mockResolvedValue([
      githubInstallation('int-primary', ['octocat/hello']),
      githubInstallation('int-second', ['octocat/hello']),
    ]);
    mockListBranches.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await expect(
      caller.listRepositoryBranches({
        organizationId: ORG_ID,
        platform: 'github',
        repository: { fullName: 'octocat/hello' },
      })
    ).rejects.toBeDefined();
    expect(mockListBranches).toHaveBeenCalledTimes(1);
  });

  it('refuses when the organization has no healthy GitHub installation', async () => {
    mockGetIntegrationsByOrganization.mockResolvedValueOnce([]);
    await expect(
      caller.listRepositoryBranches({
        organizationId: ORG_ID,
        platform: 'github',
        repository: { fullName: 'octocat/hello' },
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('No GitHub') });

    mockGetIntegrationsByOrganization.mockResolvedValueOnce([
      { ...githubInstallation('int-revoked', ['octocat/hello']), integration_status: 'revoked' },
    ]);
    await expect(
      caller.listRepositoryBranches({
        organizationId: ORG_ID,
        platform: 'github',
        repository: { fullName: 'octocat/hello' },
      })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('no longer active'),
    });
    expect(mockListBranches).not.toHaveBeenCalled();
  });

  it('lists GitLab branches with the acting user as the credential actor', async () => {
    mockGetIntegrationForOwner.mockResolvedValue(gitlabIntegration);
    const result = await caller.listRepositoryBranches({
      organizationId: ORG_ID,
      platform: 'gitlab',
      repository: { fullName: 'group/proj' },
    });
    expect(result).toEqual({ defaultBranch: 'dev', branches: ['dev', 'release'] });
    // The cache match authorizes the project; the token releases for the
    // acting user inside the organization.
    expect(mockGetValidGitLabToken).toHaveBeenCalledWith(gitlabIntegration, {
      userId: USER_ID,
      organizationId: ORG_ID,
    });
    expect(mockFetchGitLabBranches).toHaveBeenCalledWith(
      'glpat-mock-token',
      'group/proj',
      'https://gitlab.example.com'
    );
  });

  it('refuses an organization GitLab project outside the connected repositories', async () => {
    mockGetIntegrationForOwner.mockResolvedValue(gitlabIntegration);
    await expect(
      caller.listRepositoryBranches({
        organizationId: ORG_ID,
        platform: 'gitlab',
        repository: { fullName: 'other/project' },
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
    expect(mockFetchGitLabBranches).not.toHaveBeenCalled();
  });

  it('lists Bitbucket branches with the server-derived workspace identity and follows pagination inside it', async () => {
    const result = await caller.listRepositoryBranches({
      organizationId: ORG_ID,
      platform: 'bitbucket',
      repository: { fullName: 'acme/widgets' },
    });
    expect(mockAuthorizeRepository).toHaveBeenCalledWith(
      { type: 'organization', organizationId: ORG_ID, userId: USER_ID },
      'acme',
      'widgets'
    );
    // The repository-metadata default and the paged refs both address the
    // SERVER-DERIVED identity ('Acme'/'Widgets'), never the client's casing:
    // a page cursor can only ever walk the authorized repository's own
    // refs/branches path. The default branch comes from the repository
    // object's `mainbranch` — Bitbucket Cloud has no `/branch-model`
    // endpoint, so the listing must not invent one.
    expect(mockRequestBitbucketJson).toHaveBeenCalledTimes(1);
    expect(mockRequestBitbucketJson).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'workspace-token' }),
      '/2.0/repositories/Acme/Widgets'
    );
    expect(mockFetchPage).toHaveBeenCalledTimes(2);
    const [accessArg, basePath, identity, cursor, guard] = mockFetchPage.mock.calls[0];
    expect(accessArg).toEqual(expect.objectContaining({ accessToken: 'workspace-token' }));
    expect(basePath).toBe('/2.0/repositories/Acme/Widgets/refs/branches');
    expect(identity).toBe('bitbucket-branches:Acme/Widgets');
    expect(cursor).toBeUndefined();
    expect(typeof guard).toBe('function');
    expect(mockFetchPage.mock.calls[1][3]).toBe('page-2');
    expect(result).toEqual({
      defaultBranch: 'master',
      branches: ['master', 'feat', 'release'],
    });
  });

  it('keeps the branch list when the repository-metadata read fails — the default is optional context', async () => {
    mockRequestBitbucketJson.mockRejectedValueOnce(
      new BitbucketReviewError('not_found', 'no model')
    );
    mockFetchPage.mockResolvedValueOnce({
      values: [{ name: 'any', type: 'branch' }],
      nextCursor: null,
    });
    const result = await caller.listRepositoryBranches({
      organizationId: ORG_ID,
      platform: 'bitbucket',
      repository: { fullName: 'acme/widgets' },
    });
    expect(result).toEqual({ defaultBranch: null, branches: ['any'] });
  });

  it('surfaces a retryable refs failure as a retry error, never as an empty success', async () => {
    mockFetchPage.mockRejectedValueOnce(
      new BitbucketReviewError('retryable', 'Bitbucket is temporarily unavailable.')
    );
    await expect(
      caller.listRepositoryBranches({
        organizationId: ORG_ID,
        platform: 'bitbucket',
        repository: { fullName: 'acme/widgets' },
      })
    ).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
  });

  it('accepts no integration id, token, or host from the client', async () => {
    for (const smuggled of [
      { integrationId: 'int-1' },
      { accessToken: 'secret' },
      { instanceUrl: 'https://evil.example' },
    ]) {
      await expect(
        caller.listRepositoryBranches({
          organizationId: ORG_ID,
          platform: 'github',
          repository: { fullName: 'octocat/hello' },
          ...smuggled,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(mockGetIntegrationsByOrganization).not.toHaveBeenCalled();
    expect(mockListBranches).not.toHaveBeenCalled();
  });
});
