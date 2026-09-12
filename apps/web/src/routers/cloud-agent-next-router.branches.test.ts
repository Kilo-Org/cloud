/**
 * @jest-environment node
 */
import { describe, expect, it, beforeAll, beforeEach } from '@jest/globals';
// @swc/jest only hoists `jest.mock` calls when `jest` is the GLOBAL binding
// (@types/jest). Importing `jest` from '@jest/globals' defeats hoisting: the
// mocked modules load for real before registration. Same pattern as
// github-pr-review-router.test.ts.
import { createCallerFactory } from '@/lib/trpc/init';
import type { User } from '@kilocode/db/schema';
import { BITBUCKET_ORGANIZATION_ONLY_MESSAGE } from '@/lib/provider-review/bitbucket-authorization';
import { cloudAgentNextRouter } from './cloud-agent-next-router';

const USER_ID = 'user-1';

// ----- mocked seams (all factories delegate lazily) ----------------------------

// The cloud-agent router's heavy runtime deps, mocked exactly as
// cloud-agent-next-router.test.ts does so the router module loads without
// network, PostHog, or R2 clients.
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
jest.mock('@/lib/user/balance', () => ({ getBalanceForUser: jest.fn() }));
jest.mock('@/lib/cloud-agent/github-integration-helpers', () => ({
  fetchGitHubRepositoriesForUser: jest.fn(),
}));
jest.mock('@/lib/cloud-agent/gitlab-integration-helpers', () => ({
  buildGitLabCloneUrl: jest.fn(),
  fetchGitLabRepositoriesForUser: jest.fn(),
  getGitLabInstanceUrlForUser: jest.fn(),
}));
jest.mock('@/lib/cloud-agent/order-repositories', () => ({
  orderRepositoriesByUsage: jest.fn(async ({ repositories }: any) => repositories),
}));
jest.mock('@/lib/r2/cloud-agent-attachments', () => ({
  generateImageUploadUrl: jest.fn(),
  generateCloudAgentAttachmentUploadUrl: jest.fn(),
  generateCloudAgentAttachmentDownloadUrl: jest.fn(),
}));
jest.mock('@/lib/cloud-agent/session-ownership', () => ({
  verifyUserOwnsSessionV2ByCloudAgentId: jest.fn(),
}));

// The branch listing's provider seams: the integration lookup, the GitHub
// and GitLab branch services, and the Bitbucket authorization/read layer.
const mockGetIntegrationForOwner = jest.fn();
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (...a: unknown[]) => mockGetIntegrationForOwner(...a),
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

/** An active GitLab integration whose repository cache lists the project. */
const gitlabIntegration = {
  id: 'int-1',
  integration_status: 'active',
  metadata: { gitlab_instance_url: 'https://gitlab.example.com' },
  repositories: [{ id: 7, name: 'proj', full_name: 'group/sub/proj', private: true }],
};

let caller: any;

beforeAll(() => {
  caller = createCallerFactory(cloudAgentNextRouter)({
    user: { id: USER_ID, is_admin: false } as User,
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetIntegrationForOwner.mockResolvedValue(activeIntegration);
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
});

describe('cloudAgentNextRouter.listRepositoryBranches (personal)', () => {
  it('lists GitHub branches against the USER-owned integration the server resolved', async () => {
    const result = await caller.listRepositoryBranches({
      platform: 'github',
      repository: { fullName: 'octocat/hello' },
    });
    expect(result).toEqual({ defaultBranch: 'main', branches: ['main', 'feature/x'] });
    expect(mockGetIntegrationForOwner).toHaveBeenCalledWith(
      { type: 'user', id: USER_ID },
      'github'
    );
    expect(mockListBranches).toHaveBeenCalledWith(
      { type: 'user', id: USER_ID },
      'int-1',
      'octocat/hello'
    );
  });

  it('lists GitLab branches from the repository-cache-authorized project', async () => {
    mockGetIntegrationForOwner.mockResolvedValue(gitlabIntegration);
    const result = await caller.listRepositoryBranches({
      platform: 'gitlab',
      repository: { fullName: 'group/sub/proj' },
    });
    expect(result).toEqual({ defaultBranch: 'dev', branches: ['dev', 'release'] });
    expect(mockGetIntegrationForOwner).toHaveBeenCalledWith(
      { type: 'user', id: USER_ID },
      'gitlab'
    );
    // The token and instance are server-derived; the project is the cache
    // match, never the caller's raw path.
    expect(mockGetValidGitLabToken).toHaveBeenCalledWith(gitlabIntegration, { userId: USER_ID });
    expect(mockFetchGitLabBranches).toHaveBeenCalledWith(
      'glpat-mock-token',
      'group/sub/proj',
      'https://gitlab.example.com'
    );
  });

  it('refuses a GitLab project outside the connected repositories', async () => {
    mockGetIntegrationForOwner.mockResolvedValue(gitlabIntegration);
    await expect(
      caller.listRepositoryBranches({
        platform: 'gitlab',
        repository: { fullName: 'other/project' },
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
    expect(mockFetchGitLabBranches).not.toHaveBeenCalled();
  });

  it('reports Bitbucket as organization-only — an explicit refusal, never an empty success', async () => {
    await expect(
      caller.listRepositoryBranches({
        platform: 'bitbucket',
        repository: { fullName: 'acme/widgets' },
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: BITBUCKET_ORGANIZATION_ONLY_MESSAGE,
    });
    expect(mockAuthorizeRepository).not.toHaveBeenCalled();
    expect(mockGetIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockFetchPage).not.toHaveBeenCalled();
  });

  it('refuses a missing or inactive integration with a clear NOT_FOUND', async () => {
    mockGetIntegrationForOwner.mockResolvedValueOnce(null);
    await expect(
      caller.listRepositoryBranches({
        platform: 'github',
        repository: { fullName: 'octocat/hello' },
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('GitHub') });
    expect(mockListBranches).not.toHaveBeenCalled();

    mockGetIntegrationForOwner.mockResolvedValueOnce({
      id: 'int-9',
      integration_status: 'revoked',
    });
    await expect(
      caller.listRepositoryBranches({
        platform: 'gitlab',
        repository: { fullName: 'group/proj' },
      })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('no longer active'),
    });
    expect(mockFetchGitLabBranches).not.toHaveBeenCalled();
  });

  it('accepts no integration id, token, organizationId, or host from the client', async () => {
    for (const smuggled of [
      { integrationId: 'int-1' },
      { token: 'ghp_secret' },
      { organizationId: '2b1d4c8e-9f3a-4e5d-8c7b-6a5948372615' },
      { host: 'https://evil.example' },
    ]) {
      await expect(
        caller.listRepositoryBranches({
          platform: 'github',
          repository: { fullName: 'octocat/hello' },
          ...smuggled,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    // The repository must be the nested { fullName } shape.
    await expect(
      caller.listRepositoryBranches({ platform: 'github', fullName: 'octocat/hello' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockGetIntegrationForOwner).not.toHaveBeenCalled();
  });

  it('rejects a malformed repository full name', async () => {
    for (const fullName of ['noseparator', '', 'trailing/', 'spaces not/allowed']) {
      await expect(
        caller.listRepositoryBranches({ platform: 'github', repository: { fullName } })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(mockListBranches).not.toHaveBeenCalled();
  });
});
