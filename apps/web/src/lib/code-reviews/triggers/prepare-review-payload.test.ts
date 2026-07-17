const mockGenerateGitHubInstallationToken = jest.fn();
const mockFindKiloReviewComment = jest.fn();
const mockFetchPRInlineComments = jest.fn();
const mockGetPRHeadCommit = jest.fn();
const mockFetchGitHubRootTextFileAtRef = jest.fn();
const mockFetchGitHubRepositorySize = jest.fn();
const mockFindKiloReviewNote = jest.fn();
const mockFetchMRInlineComments = jest.fn();
const mockGetMRHeadCommit = jest.fn();
const mockGetMRDiffRefs = jest.fn();
const mockFetchGitLabRootTextFileAtRef = jest.fn();
const mockFetchGitLabRepositorySize = jest.fn();
const mockGetOrCreateProjectAccessToken = jest.fn();
const mockFindPreviousCompletedReview = jest.fn();
const mockUpdatePreviousReviewSummary = jest.fn();
const mockUpdateRepositoryReviewInstructionsMetadata = jest.fn();
const mockGenerateReviewPrompt = jest.fn();

import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import type * as CodeReviewsDb from '@/lib/code-reviews/db/code-reviews';

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: (...args: unknown[]) =>
    mockGenerateGitHubInstallationToken(...args),
  findKiloReviewComment: (...args: unknown[]) => mockFindKiloReviewComment(...args),
  fetchPRInlineComments: (...args: unknown[]) => mockFetchPRInlineComments(...args),
  getPRHeadCommit: (...args: unknown[]) => mockGetPRHeadCommit(...args),
  fetchGitHubRootTextFileAtRef: (...args: unknown[]) => mockFetchGitHubRootTextFileAtRef(...args),
  fetchGitHubRepositorySize: (...args: unknown[]) => mockFetchGitHubRepositorySize(...args),
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  findKiloReviewNote: (...args: unknown[]) => mockFindKiloReviewNote(...args),
  fetchMRInlineComments: (...args: unknown[]) => mockFetchMRInlineComments(...args),
  getMRHeadCommit: (...args: unknown[]) => mockGetMRHeadCommit(...args),
  getMRDiffRefs: (...args: unknown[]) => mockGetMRDiffRefs(...args),
  fetchGitLabRootTextFileAtRef: (...args: unknown[]) => mockFetchGitLabRootTextFileAtRef(...args),
  fetchGitLabRepositorySize: (...args: unknown[]) => mockFetchGitLabRepositorySize(...args),
  GitLabProjectAccessTokenPermissionError: class GitLabProjectAccessTokenPermissionError extends Error {},
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getOrCreateProjectAccessToken: (...args: unknown[]) => mockGetOrCreateProjectAccessToken(...args),
}));

jest.mock('@/lib/code-reviews/prompts/generate-prompt', () => ({
  generateReviewPrompt: (...args: unknown[]) => mockGenerateReviewPrompt(...args),
}));

jest.mock('@/lib/code-reviews/db/code-reviews', () => {
  const actual = jest.requireActual<typeof CodeReviewsDb>('@/lib/code-reviews/db/code-reviews');
  return {
    ...actual,
    findPreviousCompletedReview: (...args: unknown[]) => mockFindPreviousCompletedReview(...args),
    updatePreviousReviewSummary: (...args: unknown[]) => mockUpdatePreviousReviewSummary(...args),
    updateRepositoryReviewInstructionsMetadata: (...args: unknown[]) =>
      mockUpdateRepositoryReviewInstructionsMetadata(...args),
  };
});

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cloud_agent_code_reviews,
  kilocode_users,
  organizations,
  platform_integrations,
  type PlatformIntegration,
  type User,
} from '@kilocode/db/schema';
import { eq, or } from 'drizzle-orm';
import { prepareReviewPayload } from './prepare-review-payload';

const REPO = `test-org/prepare-review-payload-${Date.now()}`;
const BITBUCKET_WORKSPACE_UUID = 'a07d5c40-2d2d-4e79-a812-6a47824a77d6';
const BITBUCKET_REPOSITORY_UUID = '38a47a32-cb87-4a9f-b75d-7224774bba77';
const BITBUCKET_REPOSITORY_SLUG = 'review-repository';
const BITBUCKET_REPO = `review-workspace/${BITBUCKET_REPOSITORY_SLUG}`;
const BITBUCKET_HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

const baseAgentConfig = {
  review_style: 'balanced',
  focus_areas: [],
  custom_instructions: '',
  model_slug: 'test-model',
  repository_selection_mode: 'all',
  gate_threshold: 'off',
  disable_review_md: false,
} satisfies CodeReviewAgentConfig;

function defineIntegration(
  userId: string,
  overrides: Partial<typeof platform_integrations.$inferInsert> = {}
): typeof platform_integrations.$inferInsert {
  return {
    owned_by_user_id: userId,
    platform: 'github',
    integration_type: 'app',
    platform_installation_id: `installation-${Date.now()}-${Math.random()}`,
    platform_account_id: '12345',
    platform_account_login: 'test-org',
    repository_access: 'all',
    integration_status: 'active',
    github_app_type: 'standard',
    ...overrides,
  };
}

function defineReview(
  userId: string,
  integrationId: string | null,
  overrides: Partial<typeof cloud_agent_code_reviews.$inferInsert> = {}
): typeof cloud_agent_code_reviews.$inferInsert {
  return {
    owned_by_user_id: userId,
    platform_integration_id: integrationId,
    repo_full_name: REPO,
    pr_number: 123,
    pr_url: `https://github.com/${REPO}/pull/123`,
    pr_title: 'Test PR',
    pr_author: 'octocat',
    base_ref: 'main',
    head_ref: 'feature/review-policy',
    head_sha: 'headsha123',
    platform: 'github',
    status: 'pending',
    ...overrides,
  };
}

describe('prepareReviewPayload', () => {
  let testUser: User;
  let testOrganizationId: string;
  let integration: PlatformIntegration;
  let gitlabIntegration: PlatformIntegration;
  let bitbucketIntegration: PlatformIntegration;

  beforeAll(async () => {
    testUser = await insertTestUser();
    const [organization] = await db
      .insert(organizations)
      .values({ name: `Prepare Review Payload ${Date.now()}` })
      .returning({ id: organizations.id });
    testOrganizationId = organization.id;
    [integration] = await db
      .insert(platform_integrations)
      .values(defineIntegration(testUser.id))
      .returning();
    [gitlabIntegration] = await db
      .insert(platform_integrations)
      .values(
        defineIntegration(testUser.id, {
          platform: 'gitlab',
          integration_type: 'oauth',
          platform_installation_id: `gitlab-installation-${Date.now()}-${Math.random()}`,
          metadata: {
            access_token: 'gitlab-oauth-token',
            gitlab_instance_url: 'https://gitlab.example.com',
          },
        })
      )
      .returning();
    [bitbucketIntegration] = await db
      .insert(platform_integrations)
      .values(
        defineIntegration(testUser.id, {
          owned_by_user_id: null,
          owned_by_organization_id: testOrganizationId,
          platform: 'bitbucket',
          integration_type: 'workspace_access_token',
          platform_installation_id: null,
          platform_account_id: BITBUCKET_WORKSPACE_UUID,
          platform_account_login: 'review-workspace',
          repository_access: 'selected',
          repositories: [
            {
              id: BITBUCKET_REPOSITORY_UUID,
              name: 'Review repository',
              full_name: BITBUCKET_REPO,
              private: true,
              default_branch: 'main',
            },
          ],
          integration_status: 'active',
          auth_invalid_at: null,
          github_app_type: null,
        })
      )
      .returning();
  });

  beforeEach(() => {
    mockGenerateGitHubInstallationToken.mockResolvedValue({
      token: 'github-token',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    mockFindKiloReviewComment.mockResolvedValue(null);
    mockFetchPRInlineComments.mockResolvedValue([]);
    mockGetPRHeadCommit.mockResolvedValue('headsha123');
    mockFetchGitHubRootTextFileAtRef.mockResolvedValue('# Review policy\n\nFlag only regressions.');
    mockFetchGitHubRepositorySize.mockResolvedValue('100 MB');
    mockFindKiloReviewNote.mockResolvedValue(null);
    mockFetchMRInlineComments.mockResolvedValue([]);
    mockGetMRHeadCommit.mockResolvedValue('headsha123');
    mockGetMRDiffRefs.mockResolvedValue({
      baseSha: 'base-sha',
      startSha: 'start-sha',
      headSha: 'headsha123',
    });
    mockFetchGitLabRootTextFileAtRef.mockResolvedValue('# GitLab review policy');
    mockFetchGitLabRepositorySize.mockResolvedValue('100 MB');
    mockGetOrCreateProjectAccessToken.mockResolvedValue('gitlab-project-token');
    mockFindPreviousCompletedReview.mockResolvedValue(null);
    mockUpdatePreviousReviewSummary.mockResolvedValue(undefined);
    mockUpdateRepositoryReviewInstructionsMetadata.mockResolvedValue(undefined);
    mockGenerateReviewPrompt.mockResolvedValue({
      prompt: 'generated prompt',
      version: 'test-version',
    });
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(
        or(
          eq(cloud_agent_code_reviews.owned_by_user_id, testUser.id),
          eq(cloud_agent_code_reviews.owned_by_organization_id, testOrganizationId)
        )
      );
    mockGenerateGitHubInstallationToken.mockReset();
    mockFindKiloReviewComment.mockReset();
    mockFetchPRInlineComments.mockReset();
    mockGetPRHeadCommit.mockReset();
    mockFetchGitHubRootTextFileAtRef.mockReset();
    mockFetchGitHubRepositorySize.mockReset();
    mockFindKiloReviewNote.mockReset();
    mockFetchMRInlineComments.mockReset();
    mockGetMRHeadCommit.mockReset();
    mockGetMRDiffRefs.mockReset();
    mockFetchGitLabRootTextFileAtRef.mockReset();
    mockFetchGitLabRepositorySize.mockReset();
    mockGetOrCreateProjectAccessToken.mockReset();
    mockFindPreviousCompletedReview.mockReset();
    mockUpdatePreviousReviewSummary.mockReset();
    mockUpdateRepositoryReviewInstructionsMetadata.mockReset();
    mockGenerateReviewPrompt.mockReset();
  });

  afterAll(async () => {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.id, bitbucketIntegration.id));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.id, gitlabIntegration.id));
    await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));
    await db.delete(organizations).where(eq(organizations.id, testOrganizationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  it('fetches GitHub REVIEW.md from the base ref when enabled and persists used metadata', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id))
      .returning();

    const payload = await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { config: baseAgentConfig },
      platform: 'github',
    });

    expect(mockFetchGitHubRootTextFileAtRef).toHaveBeenCalledWith({
      token: 'github-token',
      owner: 'test-org',
      repo: REPO.split('/')[1],
      path: 'REVIEW.md',
      ref: 'main',
    });
    expect(mockFetchGitHubRepositorySize).toHaveBeenCalledWith({
      token: 'github-token',
      owner: 'test-org',
      repo: REPO.split('/')[1],
    });
    expect(payload.repositorySize).toBe('100 MB');
    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({
        repositoryReviewInstructions: '# Review policy\n\nFlag only regressions.',
      })
    );
    expect(mockFindPreviousCompletedReview).toHaveBeenCalledWith(
      {
        owner: { type: 'user', id: testUser.id, userId: testUser.id },
        platform: 'github',
        repoFullName: REPO,
        prNumber: 123,
      },
      'headsha123'
    );
    expect(mockUpdatePreviousReviewSummary).toHaveBeenCalledWith(review.id, {
      body: null,
      headSha: null,
    });
    expect(mockUpdateRepositoryReviewInstructionsMetadata).toHaveBeenCalledWith(review.id, {
      used: true,
      ref: 'main',
      truncated: false,
    });
    expect(mockUpdateRepositoryReviewInstructionsMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerateReviewPrompt.mock.invocationCallOrder[0]
    );
  });

  it('captures the previous summary before generating the update prompt', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id))
      .returning();
    const previousSummaryBody = '<!-- kilo-review -->\n## Code Review Summary\n\nOld findings';
    mockFindKiloReviewComment.mockResolvedValueOnce({
      commentId: 99,
      body: previousSummaryBody,
    });
    mockFindPreviousCompletedReview.mockResolvedValueOnce({
      head_sha: 'previous-head-sha',
      session_id: null,
    });

    await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { config: baseAgentConfig },
      platform: 'github',
    });

    expect(mockUpdatePreviousReviewSummary).toHaveBeenCalledWith(review.id, {
      body: previousSummaryBody,
      headSha: 'previous-head-sha',
    });
    expect(mockUpdatePreviousReviewSummary.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerateReviewPrompt.mock.invocationCallOrder[0]
    );
  });

  it('infers no-issues status from the current summary without archived warnings', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id))
      .returning();
    mockFindKiloReviewComment.mockResolvedValueOnce({
      commentId: 99,
      body: [
        '<!-- kilo-review -->',
        '## Code Review Summary',
        '',
        '**Status:** No Issues Found | **Recommendation:** Merge',
        '',
        '<!-- kilo-review-history -->',
        '<details>',
        '<summary><b>Previous Review Summary</b></summary>',
        '',
        '<!-- kilo-review-history-entry -->',
        '### Previous review',
        '',
        '**Status:** 1 Issue Found',
        '',
        'Archived WARNING',
        '',
        '</details>',
        '<!-- /kilo-review-history -->',
      ].join('\n'),
    });

    await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { config: baseAgentConfig },
      platform: 'github',
    });

    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({
        existingReviewState: expect.objectContaining({ previousStatus: 'no-issues' }),
      })
    );
  });

  it('infers issues-found status from the current summary without archived no-issues text', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id))
      .returning();
    mockFindKiloReviewComment.mockResolvedValueOnce({
      commentId: 99,
      body: [
        '<!-- kilo-review -->',
        '## Code Review Summary',
        '',
        '**Status:** 1 Issue Found | **Recommendation:** Address before merge',
        '',
        'WARNING in current summary',
        '',
        '<!-- kilo-review-history -->',
        '<details>',
        '<summary><b>Previous Review Summary</b></summary>',
        '',
        '<!-- kilo-review-history-entry -->',
        '### Previous review',
        '',
        '**Status:** No Issues Found | **Recommendation:** Merge',
        '',
        '</details>',
        '<!-- /kilo-review-history -->',
      ].join('\n'),
    });

    await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { config: baseAgentConfig },
      platform: 'github',
    });

    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({
        existingReviewState: expect.objectContaining({ previousStatus: 'issues-found' }),
      })
    );
  });

  it('fetches GitLab REVIEW.md from the base ref when enabled', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        defineReview(testUser.id, gitlabIntegration.id, {
          platform: 'gitlab',
          platform_project_id: 456,
          pr_url: `https://gitlab.example.com/${REPO}/-/merge_requests/123`,
        })
      )
      .returning();

    const payload = await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { config: baseAgentConfig },
      platform: 'gitlab',
    });

    expect(payload.sessionInput).toMatchObject({
      gitUrl: `https://gitlab.example.com/${REPO}.git`,
      gitToken: 'gitlab-project-token',
      platform: 'gitlab',
    });
    expect(payload.repositorySize).toBe('100 MB');
    expect(payload.sessionInput).not.toHaveProperty('gitlabCodeReviewTokenRef');
    expect(mockFetchGitLabRepositorySize).toHaveBeenCalledWith(
      'gitlab-project-token',
      REPO,
      'https://gitlab.example.com'
    );
    expect(mockFindPreviousCompletedReview).toHaveBeenCalledWith(
      {
        owner: { type: 'user', id: testUser.id, userId: testUser.id },
        platform: 'gitlab',
        repoFullName: REPO,
        prNumber: 123,
      },
      'headsha123'
    );
    expect(mockFetchGitLabRootTextFileAtRef).toHaveBeenCalledWith(
      'gitlab-project-token',
      REPO,
      'REVIEW.md',
      'main',
      'https://gitlab.example.com'
    );
    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({
        gitlabContext: { baseSha: 'base-sha', startSha: 'start-sha', headSha: 'headsha123' },
        repositoryReviewInstructions: '# GitLab review policy',
      })
    );
    expect(mockUpdateRepositoryReviewInstructionsMetadata).toHaveBeenCalledWith(review.id, {
      used: true,
      ref: 'main',
      truncated: false,
    });
  });

  it('builds forward-shaped reviewAgents for a standard review (single agent mirroring the session model)', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        defineReview(testUser.id, gitlabIntegration.id, {
          platform: 'gitlab',
          platform_project_id: 456,
          pr_url: `https://gitlab.example.com/${REPO}/-/merge_requests/123`,
        })
      )
      .returning();

    const payload = await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { config: { ...baseAgentConfig, thinking_effort: 'high' } },
      platform: 'gitlab',
    });

    // Standard review => exactly one 'standard' agent, and agents[0] mirrors what the
    // session actually runs on (no drift between the two).
    expect(payload.reviewAgents).toEqual({
      reviewType: 'standard',
      agents: [{ role: 'standard', model: 'test-model', thinkingEffort: 'high' }],
    });
    expect(payload.reviewAgents.agents[0].model).toBe(payload.sessionInput.model);
    expect(payload.reviewAgents.agents[0].thinkingEffort).toBe(payload.sessionInput.variant);
  });

  it('throws when a provider GitLab review is missing its integration', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        defineReview(testUser.id, null, {
          platform: 'gitlab',
          pr_url: `https://gitlab.example.com/${REPO}/-/merge_requests/123`,
        })
      )
      .returning();

    await expect(
      prepareReviewPayload({
        reviewId: review.id,
        owner: { type: 'user', id: testUser.id, userId: testUser.id },
        agentConfig: { config: baseAgentConfig },
        platform: 'gitlab',
      })
    ).rejects.toThrow('is missing its integration');
  });

  it('prepares a fresh tokenless Bitbucket review from exact organization integration identity', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        defineReview(testUser.id, bitbucketIntegration.id, {
          owned_by_user_id: null,
          owned_by_organization_id: testOrganizationId,
          platform: 'bitbucket',
          repo_full_name: BITBUCKET_REPO,
          pr_url: `https://bitbucket.org/${BITBUCKET_REPO}/pull-requests/123`,
          head_sha: BITBUCKET_HEAD_SHA,
        })
      )
      .returning();
    mockFindPreviousCompletedReview.mockResolvedValueOnce({
      head_sha: 'previous-bitbucket-head',
      session_id: 'agent_previous_bitbucket',
    });
    const bitbucketConfig = {
      ...baseAgentConfig,
      repository_selection_mode: 'selected' as const,
      selected_repository_ids: [BITBUCKET_REPOSITORY_UUID],
      gate_threshold: 'critical' as const,
      disable_review_md: false,
      review_memory_enabled: true,
      review_analytics_enabled: true,
    } satisfies CodeReviewAgentConfig;

    const payload = await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'org', id: testOrganizationId, userId: testUser.id },
      agentConfig: { config: bitbucketConfig },
      platform: 'bitbucket',
    });

    expect(payload).toMatchObject({
      reviewId: review.id,
      owner: { type: 'org', id: testOrganizationId, userId: testUser.id },
      sessionInput: {
        gitUrl: `https://bitbucket.org/${BITBUCKET_REPO}.git`,
        kilocodeOrganizationId: testOrganizationId,
        platform: 'bitbucket',
        bitbucketWorkspaceUuid: BITBUCKET_WORKSPACE_UUID,
        bitbucketWorkspaceSlug: 'review-workspace',
        bitbucketRepositoryUuid: BITBUCKET_REPOSITORY_UUID,
        bitbucketRepositorySlug: BITBUCKET_REPOSITORY_SLUG,
        bitbucketIntegrationId: bitbucketIntegration.id,
        bitbucketPullRequestId: 123,
        bitbucketExpectedHeadSha: BITBUCKET_HEAD_SHA,
        upstreamBranch: 'feature/review-policy',
        prompt: 'generated prompt',
      },
    });
    expect(payload.previousCloudAgentSessionId).toBeUndefined();
    // Bitbucket must carry the same forward-shaped reviewAgents contract as
    // GitHub/GitLab, mirroring the session's model (no drift).
    expect(payload.reviewAgents).toEqual({
      reviewType: 'standard',
      agents: [{ role: 'standard', model: 'test-model', thinkingEffort: null }],
    });
    expect(payload.reviewAgents.agents[0].model).toBe(payload.sessionInput.model);
    expect(payload.sessionInput).not.toHaveProperty('githubToken');
    expect(payload.sessionInput).not.toHaveProperty('gitToken');
    expect(payload.sessionInput).not.toHaveProperty('gateThreshold');
    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(bitbucketConfig, BITBUCKET_REPO, 123, {
      platform: 'bitbucket',
      expectedHeadSha: BITBUCKET_HEAD_SHA,
    });
    expect(mockFindPreviousCompletedReview).not.toHaveBeenCalled();
    expect(mockFetchGitHubRootTextFileAtRef).not.toHaveBeenCalled();
    expect(mockFetchGitLabRootTextFileAtRef).not.toHaveBeenCalled();
    expect(mockUpdatePreviousReviewSummary).not.toHaveBeenCalled();
    expect(mockUpdateRepositoryReviewInstructionsMetadata).not.toHaveBeenCalled();
  });

  it('rejects a Bitbucket review whose repo is not selected in the integration cache', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        defineReview(testUser.id, bitbucketIntegration.id, {
          owned_by_user_id: null,
          owned_by_organization_id: testOrganizationId,
          platform: 'bitbucket',
          repo_full_name: 'review-workspace/not-selected',
          pr_url: 'https://bitbucket.org/review-workspace/not-selected/pull-requests/123',
          head_sha: BITBUCKET_HEAD_SHA,
        })
      )
      .returning();

    await expect(
      prepareReviewPayload({
        reviewId: review.id,
        owner: { type: 'org', id: testOrganizationId, userId: testUser.id },
        agentConfig: {
          config: {
            ...baseAgentConfig,
            repository_selection_mode: 'selected',
            selected_repository_ids: [BITBUCKET_REPOSITORY_UUID],
          },
        },
        platform: 'bitbucket',
      })
    ).rejects.toThrow('Bitbucket review repository identity does not match its integration cache');

    expect(mockGenerateReviewPrompt).not.toHaveBeenCalled();
  });

  it('normalizes trailing slashes in self-hosted GitLab review repository URLs', async () => {
    const [trailingSlashIntegration] = await db
      .insert(platform_integrations)
      .values(
        defineIntegration(testUser.id, {
          platform: 'gitlab',
          integration_type: 'oauth',
          platform_installation_id: `gitlab-trailing-${Date.now()}-${Math.random()}`,
          metadata: {
            access_token: 'gitlab-oauth-token',
            gitlab_instance_url: 'https://gitlab.example.com/gitlab/',
          },
        })
      )
      .returning();
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        defineReview(testUser.id, trailingSlashIntegration.id, {
          platform: 'gitlab',
          platform_project_id: 456,
          pr_url: `https://gitlab.example.com/gitlab/${REPO}/-/merge_requests/123`,
        })
      )
      .returning();

    try {
      const payload = await prepareReviewPayload({
        reviewId: review.id,
        owner: { type: 'user', id: testUser.id, userId: testUser.id },
        agentConfig: { config: baseAgentConfig },
        platform: 'gitlab',
      });

      expect(payload.sessionInput.gitUrl).toBe(`https://gitlab.example.com/gitlab/${REPO}.git`);
    } finally {
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.id, trailingSlashIntegration.id));
    }
  });

  it('falls back to built-in guidance when REVIEW.md is missing', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id))
      .returning();
    mockFetchGitHubRootTextFileAtRef.mockResolvedValueOnce(null);

    await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { config: baseAgentConfig },
      platform: 'github',
    });

    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({ repositoryReviewInstructions: null })
    );
    expect(mockUpdateRepositoryReviewInstructionsMetadata).toHaveBeenCalledWith(review.id, {
      used: false,
      ref: null,
      truncated: false,
    });
  });

  it('continues payload preparation when repository size lookup fails', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id))
      .returning();
    mockFetchGitHubRepositorySize.mockRejectedValueOnce(new Error('metadata unavailable'));

    const payload = await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { config: baseAgentConfig },
      platform: 'github',
    });

    expect(payload.repositorySize).toBeNull();
    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.any(Object)
    );
  });

  it('falls back to built-in guidance when REVIEW.md is empty', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id))
      .returning();
    mockFetchGitHubRootTextFileAtRef.mockResolvedValueOnce('  \n\t\n');

    await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { config: baseAgentConfig },
      platform: 'github',
    });

    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({ repositoryReviewInstructions: null })
    );
    expect(mockUpdateRepositoryReviewInstructionsMetadata).toHaveBeenCalledWith(review.id, {
      used: false,
      ref: null,
      truncated: false,
    });
  });

  it('falls back to built-in guidance when REVIEW.md fetch fails', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id))
      .returning();
    mockFetchGitHubRootTextFileAtRef.mockRejectedValueOnce(new Error('temporary outage'));

    await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { config: baseAgentConfig },
      platform: 'github',
    });

    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({ repositoryReviewInstructions: null })
    );
    expect(mockUpdateRepositoryReviewInstructionsMetadata).toHaveBeenCalledWith(review.id, {
      used: false,
      ref: null,
      truncated: false,
    });
  });

  it('skips GitHub REVIEW.md lookup by default', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id))
      .returning();

    await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: {
        config: {
          ...baseAgentConfig,
          disable_review_md: undefined,
        },
      },
      platform: 'github',
    });

    expect(mockFetchGitHubRootTextFileAtRef).not.toHaveBeenCalled();
    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({ repositoryReviewInstructions: null })
    );
    expect(mockUpdateRepositoryReviewInstructionsMetadata).toHaveBeenCalledWith(review.id, {
      used: false,
      ref: null,
      truncated: false,
    });
  });

  it('skips GitLab REVIEW.md lookup when disabled', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        defineReview(testUser.id, gitlabIntegration.id, {
          platform: 'gitlab',
          platform_project_id: 456,
          pr_url: `https://gitlab.example.com/${REPO}/-/merge_requests/123`,
        })
      )
      .returning();

    await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: {
        config: {
          ...baseAgentConfig,
          disable_review_md: true,
        },
      },
      platform: 'gitlab',
    });

    expect(mockFetchGitLabRootTextFileAtRef).not.toHaveBeenCalled();
    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({ repositoryReviewInstructions: null })
    );
    expect(mockUpdateRepositoryReviewInstructionsMetadata).toHaveBeenCalledWith(review.id, {
      used: false,
      ref: null,
      truncated: false,
    });
  });

  it('persists truncation metadata for large REVIEW.md content', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id))
      .returning();
    mockFetchGitHubRootTextFileAtRef.mockResolvedValueOnce('a'.repeat(10_005));

    await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { config: baseAgentConfig },
      platform: 'github',
    });

    expect(mockUpdateRepositoryReviewInstructionsMetadata).toHaveBeenCalledWith(review.id, {
      used: true,
      ref: 'main',
      truncated: true,
    });
    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({
        repositoryReviewInstructions: expect.stringContaining(
          '[REVIEW.md truncated after 10000 characters.]'
        ),
      })
    );
  });

  it('uses the stable GitHub pull ref for agent checkout when the stored head_ref is a branch name', async () => {
    const prNumber = 1234;
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id, { pr_number: prNumber }))
      .returning({ id: cloud_agent_code_reviews.id });

    if (!review) {
      throw new Error('Expected inserted review');
    }

    const payload = await prepareReviewPayload({
      reviewId: review.id,
      owner: {
        type: 'user',
        id: testUser.id,
        userId: testUser.id,
      },
      agentConfig: {
        config: baseAgentConfig,
      },
      platform: 'github',
    });

    expect(payload.sessionInput).toMatchObject({
      githubRepo: REPO,
      platform: 'github',
      upstreamBranch: 'refs/pull/1234/head',
    });
    expect(payload.sessionInput).not.toHaveProperty('gitlabCodeReviewTokenRef');
  });

  it('does not continue previous cloud-agent sessions for GitHub pull-ref reviews', async () => {
    const prNumber = 1235;
    mockFindPreviousCompletedReview.mockResolvedValueOnce({
      head_sha: 'sha-previous',
      session_id: 'previous-cloud-agent-session',
    });

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id, { pr_number: prNumber }))
      .returning({ id: cloud_agent_code_reviews.id });

    if (!review) {
      throw new Error('Expected inserted review');
    }

    const payload = await prepareReviewPayload({
      reviewId: review.id,
      owner: {
        type: 'user',
        id: testUser.id,
        userId: testUser.id,
      },
      agentConfig: {
        config: baseAgentConfig,
      },
      platform: 'github',
    });

    expect(payload.previousCloudAgentSessionId).toBeUndefined();
    expect(payload.sessionInput).toMatchObject({
      githubRepo: REPO,
      platform: 'github',
      upstreamBranch: 'refs/pull/1235/head',
    });
  });
});
