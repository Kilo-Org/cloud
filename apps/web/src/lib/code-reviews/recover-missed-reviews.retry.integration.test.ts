// The unit suite mocks the database, so it cannot show the state transitions a
// restart performs. This suite runs the real sweep, the real restart sequence and
// real database rows against the test database, with the network boundaries
// faked: the GitHub adapter, the review worker, and the billing admission.

jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: async () => undefined,
  GitHubRuntimeAuthorizationError: class extends Error {
    constructor() {
      super('runtime authorization unavailable');
      this.name = 'GitHubRuntimeAuthorizationError';
    }
  },
}));

const mockFetchOpenPullRequests = jest.fn();
const mockCreateCheckRun = jest.fn();
const mockUpdateCheckRun = jest.fn();
const mockDispatchReview = jest.fn();
const mockPrepareReviewPayload = jest.fn();
const mockGetAgentConfigForOwner = jest.fn();
const mockHandlePullRequestCodeReview = jest.fn();

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchOpenPullRequests: (...args: unknown[]) => mockFetchOpenPullRequests(...args),
  createCheckRun: (...args: unknown[]) => mockCreateCheckRun(...args),
  updateCheckRun: (...args: unknown[]) => mockUpdateCheckRun(...args),
}));

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    dispatchReview: (...args: unknown[]) => mockDispatchReview(...args),
    getReviewStatus: async () => null,
    retryReviewFresh: async () => ({ success: false }),
  },
}));

jest.mock('@/lib/code-reviews/triggers/prepare-review-payload', () => ({
  prepareReviewPayload: (...args: unknown[]) => mockPrepareReviewPayload(...args),
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (...args: unknown[]) => mockGetAgentConfigForOwner(...args),
}));

jest.mock('@/lib/code-reviews/dispatch/dispatch-billing', () => ({
  MIN_CODE_REVIEW_BALANCE_MICRODOLLARS: 1_000_000,
  resolveCodeReviewDispatchBilling: async () => ({ skipBalanceCheck: true, reason: 'free_model' }),
}));

jest.mock('@/lib/integrations/platforms/github/webhook-handlers/pull-request-handler', () => ({
  handlePullRequestCodeReview: (...args: unknown[]) => mockHandlePullRequestCodeReview(...args),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { and, eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  platform_integrations,
  type User,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type { OpenPullRequest } from '@/lib/integrations/platforms/github/adapter';
import { recoverMissedReviews } from './recover-missed-reviews';
import { AUTOMATIC_RETRY_ATTEMPT_LIMIT } from './retry-review';

const RUN_SLUG = `${Date.now()}`;
const REPO = `sweep-retry-${RUN_SLUG}/widgets`;
const HEAD_SHA = `head-${RUN_SLUG}`;
// The sweep needs a numeric installation id to address the repository.
const INSTALLATION_ID = 771234567;

function openPullRequest(): OpenPullRequest {
  return {
    number: 11,
    title: 'Add a safer widget',
    body: 'Body',
    draft: false,
    htmlUrl: `https://github.com/${REPO}/pull/11`,
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    authorId: 9001,
    authorLogin: 'person',
    authorAvatarUrl: 'https://avatars.githubusercontent.com/u/9001',
    authorType: 'User',
    labels: [],
    headSha: HEAD_SHA,
    headRef: 'feature',
    headRepoFullName: REPO,
    headRepoCloneUrl: `https://github.com/${REPO}.git`,
    headRepoHtmlUrl: `https://github.com/${REPO}`,
    baseSha: 'base-sha',
    baseRef: 'main',
    baseRepoId: 501,
    baseRepoName: 'widgets',
    baseRepoFullName: REPO,
  } as OpenPullRequest;
}

describe('recoverMissedReviews restart against the database', () => {
  let user: User;
  let integrationId: string;
  let reviewSequence = 0;

  beforeAll(async () => {
    user = await insertTestUser();
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: `${INSTALLATION_ID}`,
        platform_account_id: `sweep-retry-${RUN_SLUG}`,
        platform_account_login: `sweep-retry-${RUN_SLUG}`,
        repository_access: 'all',
        integration_status: 'active',
        repositories: [
          {
            id: 501,
            name: 'widgets',
            full_name: REPO,
            private: false,
          },
        ],
      })
      .returning({ id: platform_integrations.id });
    if (!integration) throw new Error('Expected the sweep integration');
    integrationId = integration.id;
  });

  beforeEach(() => {
    mockFetchOpenPullRequests.mockResolvedValue([openPullRequest()]);
    mockCreateCheckRun.mockResolvedValue(555);
    mockUpdateCheckRun.mockResolvedValue(undefined);
    mockDispatchReview.mockResolvedValue(undefined);
    mockPrepareReviewPayload.mockImplementation((params: { reviewId: string }) => ({
      reviewId: params.reviewId,
      sessionInput: {
        prompt: 'Review this change.',
        model: 'kilo/free-model',
      },
    }));
    mockGetAgentConfigForOwner.mockResolvedValue({
      id: 'sweep-retry-config',
      config: {},
      is_enabled: true,
      runtime_state: {},
    });
    mockHandlePullRequestCodeReview.mockResolvedValue({
      status: 200,
      json: async () => ({ message: 'Code review agent not enabled for this repository' }),
    });
  });

  afterEach(async () => {
    jest.clearAllMocks();
    const reviews = await db
      .select({ id: cloud_agent_code_reviews.id })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
    for (const review of reviews) {
      await db
        .delete(cloud_agent_code_review_attempts)
        .where(eq(cloud_agent_code_review_attempts.code_review_id, review.id));
    }
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
  });

  afterAll(async () => {
    await db.delete(platform_integrations).where(eq(platform_integrations.id, integrationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, user.id));
  });

  async function insertReview(params: {
    status: 'failed' | 'queued';
    terminalReason: string | null;
    attemptCount: number;
  }) {
    const sequence = reviewSequence++;
    const timestamp = new Date(Date.now() - 120_000).toISOString();
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_user_id: user.id,
        platform_integration_id: integrationId,
        repo_full_name: REPO,
        pr_number: 11,
        pr_url: `https://github.com/${REPO}/pull/11`,
        pr_title: 'Add a safer widget',
        pr_author: 'person',
        base_ref: 'main',
        head_ref: 'feature',
        head_sha: HEAD_SHA,
        platform: 'github',
        status: params.status,
        terminal_reason: params.terminalReason,
        error_message: 'Assistant request timed out',
        created_at: timestamp,
        updated_at: timestamp,
        completed_at: params.status === 'failed' ? timestamp : null,
      })
      .returning({ id: cloud_agent_code_reviews.id });
    if (!review) throw new Error('Expected the review row');

    for (let index = 0; index < params.attemptCount; index += 1) {
      await db.insert(cloud_agent_code_review_attempts).values({
        code_review_id: review.id,
        attempt_number: index + 1,
        status: index === params.attemptCount - 1 ? params.status : 'failed',
        completed_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }
    return { reviewId: review.id, sequence };
  }

  async function storedReview(reviewId: string) {
    const [review] = await db
      .select({
        status: cloud_agent_code_reviews.status,
        terminalReason: cloud_agent_code_reviews.terminal_reason,
        dispatchReservationId: cloud_agent_code_reviews.dispatch_reservation_id,
        checkRunId: cloud_agent_code_reviews.check_run_id,
      })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId))
      .limit(1);
    return review;
  }

  async function storedAttempts(reviewId: string) {
    return db
      .select({
        attemptNumber: cloud_agent_code_review_attempts.attempt_number,
        retryOfAttemptId: cloud_agent_code_review_attempts.retry_of_attempt_id,
        retryReason: cloud_agent_code_review_attempts.retry_reason,
        status: cloud_agent_code_review_attempts.status,
      })
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, reviewId))
      .orderBy(cloud_agent_code_review_attempts.attempt_number);
  }

  it('restarts a review that stopped on a transient cause and dispatches it', async () => {
    const { reviewId } = await insertReview({
      status: 'failed',
      terminalReason: 'assistant_timeout',
      attemptCount: 1,
    });

    const summary = await recoverMissedReviews({ now: new Date() });

    expect(summary.reviewsRetried).toBeGreaterThanOrEqual(1);
    expect(await storedReview(reviewId)).toEqual(
      expect.objectContaining({
        status: 'queued',
        terminalReason: null,
        dispatchReservationId: expect.any(String),
        checkRunId: 555,
      })
    );
    expect(await storedAttempts(reviewId)).toEqual([
      expect.objectContaining({ attemptNumber: 1, retryReason: null, status: 'failed' }),
      expect.objectContaining({
        attemptNumber: 2,
        retryReason: 'automatic_recovery',
        status: 'queued',
      }),
    ]);
    expect(mockCreateCheckRun).toHaveBeenCalledWith(
      expect.any(String),
      `sweep-retry-${RUN_SLUG}`,
      'widgets',
      HEAD_SHA,
      expect.objectContaining({
        output: expect.objectContaining({ title: 'Kilo Code Review queued' }),
      }),
      'standard'
    );
    expect(mockDispatchReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId, skipBalanceCheck: true })
    );
  });

  it('leaves a restarted review alone on the next run', async () => {
    const { reviewId } = await insertReview({
      status: 'failed',
      terminalReason: 'assistant_timeout',
      attemptCount: 1,
    });

    await recoverMissedReviews({ now: new Date() });
    const attemptsAfterRestart = await storedAttempts(reviewId);
    mockDispatchReview.mockClear();

    const second = await recoverMissedReviews({ now: new Date() });

    expect(second.reviewsRetried).toBe(0);
    expect(await storedAttempts(reviewId)).toEqual(attemptsAfterRestart);
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('leaves a review that failed on a cause a restart cannot fix untouched', async () => {
    const { reviewId } = await insertReview({
      status: 'failed',
      terminalReason: 'billing',
      attemptCount: 1,
    });

    await recoverMissedReviews({ now: new Date() });

    expect(await storedReview(reviewId)).toEqual(
      expect.objectContaining({ status: 'failed', terminalReason: 'billing' })
    );
    expect(await storedAttempts(reviewId)).toHaveLength(1);
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('stops restarting a review that used all of its unattended attempts', async () => {
    const { reviewId } = await insertReview({
      status: 'failed',
      terminalReason: 'assistant_timeout',
      attemptCount: AUTOMATIC_RETRY_ATTEMPT_LIMIT,
    });

    await recoverMissedReviews({ now: new Date() });

    expect(await storedReview(reviewId)).toEqual(
      expect.objectContaining({ status: 'failed', terminalReason: 'assistant_timeout' })
    );
    expect(
      await db
        .select({ id: cloud_agent_code_review_attempts.id })
        .from(cloud_agent_code_review_attempts)
        .where(
          and(
            eq(cloud_agent_code_review_attempts.code_review_id, reviewId),
            eq(cloud_agent_code_review_attempts.attempt_number, AUTOMATIC_RETRY_ATTEMPT_LIMIT + 1)
          )
        )
    ).toHaveLength(0);
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });
});
