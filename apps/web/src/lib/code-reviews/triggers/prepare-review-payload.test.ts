const mockGenerateGitHubInstallationToken = jest.fn();
const mockFindKiloReviewComment = jest.fn();
const mockFetchPRInlineComments = jest.fn();
const mockGetPRHeadCommit = jest.fn();
const mockFetchGitHubRootTextFileAtRef = jest.fn();
const mockFindPreviousCompletedReview = jest.fn();
const mockGenerateReviewPrompt = jest.fn();

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: (...args: unknown[]) =>
    mockGenerateGitHubInstallationToken(...args),
  findKiloReviewComment: (...args: unknown[]) => mockFindKiloReviewComment(...args),
  fetchPRInlineComments: (...args: unknown[]) => mockFetchPRInlineComments(...args),
  getPRHeadCommit: (...args: unknown[]) => mockGetPRHeadCommit(...args),
  fetchGitHubRootTextFileAtRef: (...args: unknown[]) => mockFetchGitHubRootTextFileAtRef(...args),
}));

jest.mock('@/lib/code-reviews/prompts/generate-prompt', () => ({
  generateReviewPrompt: (...args: unknown[]) => mockGenerateReviewPrompt(...args),
}));

jest.mock('@/lib/code-reviews/db/code-reviews', () => {
  const actual = jest.requireActual<typeof import('@/lib/code-reviews/db/code-reviews')>(
    '@/lib/code-reviews/db/code-reviews'
  );
  return {
    ...actual,
    findPreviousCompletedReview: (...args: unknown[]) => mockFindPreviousCompletedReview(...args),
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

function defineIntegration(userId: string): typeof platform_integrations.$inferInsert {
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
  };
}

function defineReview(
  userId: string,
  integrationId: string | null
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
  };
}

describe('prepareReviewPayload REVIEW.md support', () => {
  let testUser: User;
  let integration: PlatformIntegration;

  beforeAll(async () => {
    testUser = await insertTestUser();
    [integration] = await db
      .insert(platform_integrations)
      .values(defineIntegration(testUser.id))
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
    mockFindPreviousCompletedReview.mockResolvedValue(null);
    mockGenerateReviewPrompt.mockResolvedValue({
      prompt: 'generated prompt',
      version: 'test-version',
      source: 'local',
    });
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
    mockGenerateGitHubInstallationToken.mockReset();
    mockFindKiloReviewComment.mockReset();
    mockFetchPRInlineComments.mockReset();
    mockGetPRHeadCommit.mockReset();
    mockFetchGitHubRootTextFileAtRef.mockReset();
    mockFindPreviousCompletedReview.mockReset();
    mockGenerateReviewPrompt.mockReset();
  });

  afterAll(async () => {
    await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  it('fetches REVIEW.md from the base ref and passes normalized instructions to prompt generation', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(defineReview(testUser.id, integration.id))
      .returning();

    await prepareReviewPayload({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: {
        config: {
          review_style: 'balanced',
          focus_areas: [],
          custom_instructions: '',
          model_slug: 'test-model',
          max_review_time_minutes: 30,
        },
      },
      platform: 'github',
    });

    expect(mockFetchGitHubRootTextFileAtRef).toHaveBeenCalledWith({
      installationId: integration.platform_installation_id,
      owner: 'test-org',
      repo: REPO.split('/')[1],
      path: 'REVIEW.md',
      ref: 'main',
      appType: 'standard',
    });
    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({
        repositoryReviewInstructions: '# Review policy\n\nFlag only regressions.',
      })
    );
    expect(mockFindPreviousCompletedReview).toHaveBeenCalledWith(REPO, 123, 'headsha123', 'github');
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
      agentConfig: {
        config: {
          review_style: 'balanced',
          focus_areas: [],
          custom_instructions: '',
          model_slug: 'test-model',
          max_review_time_minutes: 30,
        },
      },
      platform: 'github',
    });

    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({ repositoryReviewInstructions: null })
    );
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
      agentConfig: {
        config: {
          review_style: 'balanced',
          focus_areas: [],
          custom_instructions: '',
          model_slug: 'test-model',
          max_review_time_minutes: 30,
        },
      },
      platform: 'github',
    });

    expect(mockGenerateReviewPrompt).toHaveBeenCalledWith(
      expect.any(Object),
      REPO,
      123,
      expect.objectContaining({ repositoryReviewInstructions: null })
    );
  });
});
