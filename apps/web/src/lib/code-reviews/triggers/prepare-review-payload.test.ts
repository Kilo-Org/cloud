const mockGenerateGitHubInstallationToken = jest.fn();
const mockFindKiloReviewComment = jest.fn();
const mockFetchPRInlineComments = jest.fn();
const mockGetPRHeadCommit = jest.fn();
const mockFetchGitHubRootTextFileAtRef = jest.fn();
const mockFindKiloReviewNote = jest.fn();
const mockFetchMRInlineComments = jest.fn();
const mockGetMRHeadCommit = jest.fn();
const mockGetMRDiffRefs = jest.fn();
const mockFetchGitLabRootTextFileAtRef = jest.fn();
const mockGetOrCreateProjectAccessToken = jest.fn();
const mockFindPreviousCompletedReview = jest.fn();
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
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  findKiloReviewNote: (...args: unknown[]) => mockFindKiloReviewNote(...args),
  fetchMRInlineComments: (...args: unknown[]) => mockFetchMRInlineComments(...args),
  getMRHeadCommit: (...args: unknown[]) => mockGetMRHeadCommit(...args),
  getMRDiffRefs: (...args: unknown[]) => mockGetMRDiffRefs(...args),
  fetchGitLabRootTextFileAtRef: (...args: unknown[]) => mockFetchGitLabRootTextFileAtRef(...args),
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
  platform_integrations,
  type PlatformIntegration,
  type User,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { prepareReviewPayload } from './prepare-review-payload';

const REPO = `test-org/prepare-review-payload-${Date.now()}`;

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
  let integration: PlatformIntegration;
  let gitlabIntegration: PlatformIntegration;

  beforeAll(async () => {
    testUser = await insertTestUser();
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
    mockFindKiloReviewNote.mockResolvedValue(null);
    mockFetchMRInlineComments.mockResolvedValue([]);
    mockGetMRHeadCommit.mockResolvedValue('headsha123');
    mockGetMRDiffRefs.mockResolvedValue({
      baseSha: 'base-sha',
      startSha: 'start-sha',
      headSha: 'headsha123',
    });
    mockFetchGitLabRootTextFileAtRef.mockResolvedValue('# GitLab review policy');
    mockGetOrCreateProjectAccessToken.mockResolvedValue('gitlab-project-token');
    mockFindPreviousCompletedReview.mockResolvedValue(null);
    mockUpdateRepositoryReviewInstructionsMetadata.mockResolvedValue(undefined);
    mockGenerateReviewPrompt.mockResolvedValue({
      prompt: 'generated prompt',
      version: 'test-version',
      source: 'local',
    });
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.owned_by_user_id, testUser.id));
    mockGenerateGitHubInstallationToken.mockReset();
    mockFindKiloReviewComment.mockReset();
    mockFetchPRInlineComments.mockReset();
    mockGetPRHeadCommit.mockReset();
    mockFetchGitHubRootTextFileAtRef.mockReset();
    mockFindKiloReviewNote.mockReset();
    mockFetchMRInlineComments.mockReset();
    mockGetMRHeadCommit.mockReset();
    mockGetMRDiffRefs.mockReset();
    mockFetchGitLabRootTextFileAtRef.mockReset();
    mockGetOrCreateProjectAccessToken.mockReset();
    mockFindPreviousCompletedReview.mockReset();
    mockUpdateRepositoryReviewInstructionsMetadata.mockReset();
    mockGenerateReviewPrompt.mockReset();
  });

  afterAll(async () => {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.id, gitlabIntegration.id));
    await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  it('fetches GitHub REVIEW.md from the base ref when enabled and persists used metadata', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id))
      .returning();

    await prepareReviewPayload({
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
    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({
        repositoryReviewInstructions: '# Review policy\n\nFlag only regressions.',
      })
    );
    expect(mockFindPreviousCompletedReview).toHaveBeenCalledWith(REPO, 123, 'headsha123', {
      platform: 'github',
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
    expect(payload.sessionInput).not.toHaveProperty('gitlabCodeReviewTokenRef');
    expect(mockFindPreviousCompletedReview).toHaveBeenCalledWith(REPO, 123, 'headsha123', {
      platform: 'gitlab',
      integrationId: gitlabIntegration.id,
      projectId: 456,
    });
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

  it('skips GitLab continuation lookup when exact scope is unavailable', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        defineReview(testUser.id, null, {
          platform: 'gitlab',
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

    expect(mockGetOrCreateProjectAccessToken).not.toHaveBeenCalled();
    expect(mockFindPreviousCompletedReview).not.toHaveBeenCalled();
    expect(payload.previousCloudAgentSessionId).toBeUndefined();
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
      .values(defineReview(testUser.id, null, { pr_number: prNumber }))
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
      .values(defineReview(testUser.id, null, { pr_number: prNumber }))
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
