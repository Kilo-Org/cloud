const mockDispatchReview = jest.fn();
const mockGetReviewStatus = jest.fn();
const mockGetAgentConfigForOwner = jest.fn();
const mockPrepareReviewPayload = jest.fn();
const mockSendCodeReviewDisabledEmail = jest.fn();
const mockGetIntegrationById = jest.fn();
const mockUpdateCheckRun = jest.fn();

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    dispatchReview: (...args: unknown[]) => mockDispatchReview(...args),
    getReviewStatus: (...args: unknown[]) => mockGetReviewStatus(...args),
  },
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (...args: unknown[]) => mockGetAgentConfigForOwner(...args),
}));

jest.mock('@/lib/code-reviews/triggers/prepare-review-payload', () => ({
  prepareReviewPayload: (...args: unknown[]) => mockPrepareReviewPayload(...args),
}));

jest.mock('@/lib/email', () => ({
  sendCodeReviewDisabledEmail: (...args: unknown[]) => mockSendCodeReviewDisabledEmail(...args),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationById: (...args: unknown[]) => mockGetIntegrationById(...args),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  updateCheckRun: (...args: unknown[]) => mockUpdateCheckRun(...args),
}));

jest.mock('@/lib/constants', () => ({
  APP_URL: 'https://test.kilo.ai',
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  agent_configs,
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { or } from 'drizzle-orm';
import { tryDispatchPendingReviews } from './dispatch-pending-reviews';
import { cronPendingCodeReviewCreatedAtWindowSql } from './dispatch-constants';
import {
  cancelSupersededReviewsForPR,
  updateRepositoryReviewInstructionsMetadata,
} from '../db/code-reviews';

const REPO = `test-org/dispatch-pending-${Date.now()}`;
const FUNDED_BALANCE_MICRODOLLARS = 5_000_001;
const DEFAULT_TIER_BALANCE_MICRODOLLARS = 5_000_000;

type ReviewStatus = 'pending' | 'queued' | 'running';
type ReviewOwner = { type: 'user'; id: string } | { type: 'org'; id: string };

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

describe('tryDispatchPendingReviews', () => {
  let testUser: User;
  let testOrganizationId: string;
  let reviewSequence = 0;

  beforeAll(async () => {
    testUser = await insertTestUser();
    const [organization] = await db
      .insert(organizations)
      .values({ name: `Dispatch Pending Reviews ${Date.now()}` })
      .returning({ id: organizations.id });
    testOrganizationId = organization.id;
  });

  beforeEach(() => {
    mockDispatchReview.mockResolvedValue(undefined);
    mockGetReviewStatus.mockResolvedValue(null);
    mockGetAgentConfigForOwner.mockResolvedValue({
      id: 'test-agent-config',
      config: {},
      is_enabled: true,
      runtime_state: {},
    });
    mockPrepareReviewPayload.mockImplementation((params: { reviewId: string }) => ({
      reviewId: params.reviewId,
    }));
    mockSendCodeReviewDisabledEmail.mockResolvedValue({ sent: true });
    mockGetIntegrationById.mockResolvedValue(null);
    mockUpdateCheckRun.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
    await db
      .delete(agent_configs)
      .where(
        or(
          eq(agent_configs.owned_by_user_id, testUser.id),
          eq(agent_configs.owned_by_organization_id, testOrganizationId)
        )
      );
    mockDispatchReview.mockReset();
    mockGetReviewStatus.mockReset();
    mockGetAgentConfigForOwner.mockReset();
    mockPrepareReviewPayload.mockReset();
    mockSendCodeReviewDisabledEmail.mockReset();
    mockGetIntegrationById.mockReset();
    mockUpdateCheckRun.mockReset();
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, testOrganizationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function setTestUserBalance(totalMicrodollarsAcquired: number, microdollarsUsed = 0) {
    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: totalMicrodollarsAcquired,
        microdollars_used: microdollarsUsed,
      })
      .where(eq(kilocode_users.id, testUser.id));
  }

  function reviewValues({
    owner,
    status,
    createdAt,
    updatedAt,
    startedAt = null,
  }: {
    owner: ReviewOwner;
    status: ReviewStatus;
    createdAt: string;
    updatedAt: string;
    startedAt?: string | null;
  }) {
    const sequence = reviewSequence++;

    return {
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      owned_by_organization_id: owner.type === 'org' ? owner.id : null,
      repo_full_name: REPO,
      pr_number: sequence + 1,
      pr_url: `https://github.com/${REPO}/pull/${sequence + 1}`,
      pr_title: `Test PR ${sequence + 1}`,
      pr_author: 'octocat',
      base_ref: 'main',
      head_ref: `feature/test-${sequence}`,
      head_sha: `sha-${sequence}`,
      status,
      started_at: startedAt,
      created_at: createdAt,
      updated_at: updatedAt,
    };
  }

  async function insertAgentConfigForUser(runtimeState: Record<string, unknown> = {}) {
    const [config] = await db
      .insert(agent_configs)
      .values({
        owned_by_user_id: testUser.id,
        agent_type: 'code_review',
        platform: 'github',
        config: {},
        is_enabled: true,
        runtime_state: runtimeState,
        created_by: testUser.id,
      })
      .returning();

    return config;
  }

  async function getStoredReview(reviewId: string) {
    const [review] = await db
      .select({
        status: cloud_agent_code_reviews.status,
        terminalReason: cloud_agent_code_reviews.terminal_reason,
        dispatchReservationId: cloud_agent_code_reviews.dispatch_reservation_id,
        errorMessage: cloud_agent_code_reviews.error_message,
      })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId))
      .limit(1);

    return review;
  }

  it('keeps organization concurrency at 20 reviews', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;

    await db.insert(cloud_agent_code_reviews).values([
      ...Array.from({ length: 18 }, () =>
        reviewValues({
          owner,
          status: 'running',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
          startedAt: recentTimestamp,
        })
      ),
      ...Array.from({ length: 5 }, () =>
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      ),
    ]);

    const result = await tryDispatchPendingReviews({
      type: 'org',
      id: testOrganizationId,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 2,
      notDispatched: 0,
      activeCount: 20,
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(2);
    expect(mockPrepareReviewPayload).toHaveBeenCalledTimes(2);
  });

  it('dispatches up to 3 personal reviews when the user has more than $5 in credits', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(FUNDED_BALANCE_MICRODOLLARS);

    await db.insert(cloud_agent_code_reviews).values(
      Array.from({ length: 5 }, () =>
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
    );

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 3,
      notDispatched: 0,
      activeCount: 3,
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(3);
  });

  it('dispatches one additional funded personal review when two are already active', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(FUNDED_BALANCE_MICRODOLLARS);

    await db.insert(cloud_agent_code_reviews).values([
      ...Array.from({ length: 2 }, () =>
        reviewValues({
          owner,
          status: 'running',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
          startedAt: recentTimestamp,
        })
      ),
      ...Array.from({ length: 5 }, () =>
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      ),
    ]);

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 1,
      notDispatched: 0,
      activeCount: 3,
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('disables Code Reviewer for pre-worker GitHub installation failures', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    const agentConfig = await insertAgentConfigForUser();
    mockGetAgentConfigForOwner.mockResolvedValue(agentConfig);
    mockPrepareReviewPayload.mockRejectedValue(
      new Error(
        'GitHub token or active app installation required for this repository (no_installation_found)'
      )
    );

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const storedReview = await getStoredReview(review.id);
    const storedConfig = await db.query.agent_configs.findFirst({
      where: eq(agent_configs.id, agentConfig.id),
    });

    expect(result.dispatched).toBe(0);
    expect(mockDispatchReview).not.toHaveBeenCalled();
    expect(storedReview).toEqual(
      expect.objectContaining({
        status: 'failed',
        terminalReason: 'github_installation_required',
        dispatchReservationId: null,
      })
    );
    expect(storedConfig?.is_enabled).toBe(false);
    expect(mockSendCodeReviewDisabledEmail).toHaveBeenCalledTimes(1);
  });

  it('disables Code Reviewer for selected-model worker status failures', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    const errorMessage =
      'prepareSession failed (400): {"error":{"message":"Selected model is not available for this cloud agent session"}}';
    const agentConfig = await insertAgentConfigForUser();
    mockGetAgentConfigForOwner.mockResolvedValue(agentConfig);
    mockDispatchReview.mockRejectedValue(
      new Error("Dispatch returned terminal status 'failed' for review selected-model-review")
    );
    mockGetReviewStatus.mockResolvedValue({
      reviewId: 'unused',
      status: 'failed',
      errorMessage,
      terminalReason: 'selected_model_unavailable',
    });

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const storedReview = await getStoredReview(review.id);
    const storedConfig = await db.query.agent_configs.findFirst({
      where: eq(agent_configs.id, agentConfig.id),
    });

    expect(result).toEqual({ dispatched: 1, notDispatched: 0, activeCount: 1 });
    expect(storedReview).toEqual(
      expect.objectContaining({
        status: 'failed',
        terminalReason: 'selected_model_unavailable',
        errorMessage,
      })
    );
    expect(storedConfig?.is_enabled).toBe(false);
    expect(mockSendCodeReviewDisabledEmail).toHaveBeenCalledTimes(1);
  });

  it('refuses to prepare pending work while action-required state is present', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    const actionRequiredState = {
      code_review_action_required: {
        reason: 'byok_invalid_key',
        detectedAt: minutesAgo(10),
        lastSeenAt: minutesAgo(9),
        lastErrorMessage:
          'Code Reviewer was disabled because the selected BYOK API key is invalid or has been revoked. Update the key or choose another model, then enable Code Reviewer again.',
      },
    };
    const agentConfig = await insertAgentConfigForUser(actionRequiredState);
    mockGetAgentConfigForOwner.mockResolvedValue(agentConfig);

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const storedReview = await getStoredReview(review.id);
    const storedConfig = await db.query.agent_configs.findFirst({
      where: eq(agent_configs.id, agentConfig.id),
    });

    expect(mockPrepareReviewPayload).not.toHaveBeenCalled();
    expect(mockDispatchReview).not.toHaveBeenCalled();
    expect(mockSendCodeReviewDisabledEmail).not.toHaveBeenCalled();
    expect(storedConfig?.runtime_state).toEqual(actionRequiredState);
    expect(storedReview).toEqual(
      expect.objectContaining({
        status: 'failed',
        terminalReason: 'byok_invalid_key',
        dispatchReservationId: null,
      })
    );
  });

  it('does not dispatch funded personal reviews when three are already active', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(FUNDED_BALANCE_MICRODOLLARS);

    await db.insert(cloud_agent_code_reviews).values([
      ...Array.from({ length: 3 }, () =>
        reviewValues({
          owner,
          status: 'running',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
          startedAt: recentTimestamp,
        })
      ),
      ...Array.from({ length: 2 }, () =>
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      ),
    ]);

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 0,
      notDispatched: 0,
      activeCount: 3,
    });
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('dispatches only 1 personal review when the user has exactly $5 in credits', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);

    await db.insert(cloud_agent_code_reviews).values(
      Array.from({ length: 5 }, () =>
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
    );

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 1,
      notDispatched: 0,
      activeCount: 1,
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('dispatches only 1 personal review when the user has less than $5 in credits', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS - 1);

    await db.insert(cloud_agent_code_reviews).values(
      Array.from({ length: 5 }, () =>
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
    );

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 1,
      notDispatched: 0,
      activeCount: 1,
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('reserves a one-slot owner before slow payload preparation and releases the owner lock', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    const preparationStarted = createDeferred<void>();
    const releasePreparation = createDeferred<void>();
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);

    await db.insert(cloud_agent_code_reviews).values(
      Array.from({ length: 2 }, () =>
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
    );

    mockPrepareReviewPayload.mockImplementationOnce(async (params: { reviewId: string }) => {
      preparationStarted.resolve(undefined);
      await releasePreparation.promise;
      return { reviewId: params.reviewId };
    });

    const firstDispatch = tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    await preparationStarted.promise;

    const reviewsWhilePreparing = await db
      .select({ status: cloud_agent_code_reviews.status })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
    expect(reviewsWhilePreparing.filter(review => review.status === 'queued')).toHaveLength(1);
    expect(reviewsWhilePreparing.filter(review => review.status === 'pending')).toHaveLength(1);

    const secondResult = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });
    expect(secondResult).toEqual({ dispatched: 0, notDispatched: 0, activeCount: 1 });
    expect(mockPrepareReviewPayload).toHaveBeenCalledTimes(1);

    releasePreparation.resolve(undefined);
    await expect(firstDispatch).resolves.toEqual({
      dispatched: 1,
      notDispatched: 0,
      activeCount: 1,
    });
  });

  it('recovers stale queued reviews before payload metadata updates refresh updated_at', async () => {
    const staleQueuedTimestamp = minutesAgo(6);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);
    mockPrepareReviewPayload.mockImplementationOnce(async (params: { reviewId: string }) => {
      await updateRepositoryReviewInstructionsMetadata(params.reviewId, {
        used: false,
        ref: null,
        truncated: false,
      });
      return { reviewId: params.reviewId };
    });

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          status: 'queued',
          createdAt: staleQueuedTimestamp,
          updatedAt: staleQueuedTimestamp,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    if (!review) {
      throw new Error('Expected stale queued review to be inserted');
    }

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });

    expect(result).toEqual({ dispatched: 1, notDispatched: 0, activeCount: 1 });
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
    expect(storedReview?.status).toBe('queued');
    expect(storedReview?.updated_at).not.toBe(staleQueuedTimestamp);
  });

  it('claims the oldest pending review regardless of age', async () => {
    const oldPendingTimestamp = minutesAgo(150);
    const recentPendingTimestamp = minutesAgo(30);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);

    const [oldPendingReview, recentPendingReview] = await db
      .insert(cloud_agent_code_reviews)
      .values([
        reviewValues({
          owner,
          status: 'pending',
          createdAt: oldPendingTimestamp,
          updatedAt: oldPendingTimestamp,
        }),
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentPendingTimestamp,
          updatedAt: recentPendingTimestamp,
        }),
      ])
      .returning({ id: cloud_agent_code_reviews.id });

    if (!oldPendingReview || !recentPendingReview) {
      throw new Error('Expected old and recent pending reviews to be inserted');
    }

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const storedOldPendingReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, oldPendingReview.id),
    });
    const storedRecentPendingReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, recentPendingReview.id),
    });

    expect(result).toEqual({ dispatched: 1, notDispatched: 0, activeCount: 1 });
    expect(storedOldPendingReview?.status).toBe('queued');
    expect(storedRecentPendingReview?.status).toBe('pending');
    expect(mockPrepareReviewPayload).toHaveBeenCalledWith({
      reviewId: oldPendingReview.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { id: 'test-agent-config', config: {}, is_enabled: true, runtime_state: {} },
      platform: 'github',
    });
    expect(mockPrepareReviewPayload).not.toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: recentPendingReview.id })
    );
  });

  it('claims only pending rows created inside the cron window', async () => {
    const tooRecentTimestamp = minutesAgo(30);
    const eligibleTimestamp = minutesAgo(65);
    const tooOldTimestamp = minutesAgo(90);
    const recentlyUpdatedAt = minutesAgo(5);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);

    const [tooRecentReview, eligibleReview, tooOldReview] = await db
      .insert(cloud_agent_code_reviews)
      .values([
        reviewValues({
          owner,
          status: 'pending',
          createdAt: tooRecentTimestamp,
          updatedAt: tooRecentTimestamp,
        }),
        reviewValues({
          owner,
          status: 'pending',
          createdAt: eligibleTimestamp,
          updatedAt: recentlyUpdatedAt,
        }),
        reviewValues({
          owner,
          status: 'pending',
          createdAt: tooOldTimestamp,
          updatedAt: recentlyUpdatedAt,
        }),
      ])
      .returning({ id: cloud_agent_code_reviews.id });

    if (!tooRecentReview || !eligibleReview || !tooOldReview) {
      throw new Error('Expected pending reviews to be inserted');
    }

    const result = await tryDispatchPendingReviews(
      {
        type: 'user',
        id: testUser.id,
        userId: testUser.id,
      },
      { pendingCreatedAtWindow: cronPendingCodeReviewCreatedAtWindowSql() }
    );

    const storedTooRecentReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, tooRecentReview.id),
    });
    const storedEligibleReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, eligibleReview.id),
    });
    const storedTooOldReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, tooOldReview.id),
    });

    expect(result).toEqual({ dispatched: 1, notDispatched: 0, activeCount: 1 });
    expect(storedTooRecentReview?.status).toBe('pending');
    expect(storedEligibleReview?.status).toBe('queued');
    expect(storedTooOldReview?.status).toBe('pending');
    expect(mockPrepareReviewPayload).toHaveBeenCalledWith({
      reviewId: eligibleReview.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { id: 'test-agent-config', config: {}, is_enabled: true, runtime_state: {} },
      platform: 'github',
    });
    expect(mockPrepareReviewPayload).not.toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: tooRecentReview.id })
    );
    expect(mockPrepareReviewPayload).not.toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: tooOldReview.id })
    );
  });

  it('recovers stale queued reviews regardless of age under the cron window', async () => {
    const oldQueuedCreatedAt = minutesAgo(180);
    const staleQueuedUpdatedAt = minutesAgo(10);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          status: 'queued',
          createdAt: oldQueuedCreatedAt,
          updatedAt: staleQueuedUpdatedAt,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    if (!review) {
      throw new Error('Expected stale queued review to be inserted');
    }

    const result = await tryDispatchPendingReviews(
      {
        type: 'user',
        id: testUser.id,
        userId: testUser.id,
      },
      { pendingCreatedAtWindow: cronPendingCodeReviewCreatedAtWindowSql() }
    );

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });

    expect(result).toEqual({ dispatched: 1, notDispatched: 0, activeCount: 1 });
    expect(storedReview?.status).toBe('queued');
    expect(mockPrepareReviewPayload).toHaveBeenCalledWith({
      reviewId: review.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { id: 'test-agent-config', config: {}, is_enabled: true, runtime_state: {} },
      platform: 'github',
    });
  });

  it('does not overwrite a review that becomes terminal after reservation', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    if (!review) {
      throw new Error('Expected pending review to be inserted');
    }

    mockPrepareReviewPayload.mockImplementationOnce(async () => {
      await db
        .update(cloud_agent_code_reviews)
        .set({
          status: 'completed',
          completed_at: new Date().toISOString(),
        })
        .where(eq(cloud_agent_code_reviews.id, review.id));
      throw new Error('payload preparation failed after parent completion');
    });

    await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });
    expect(storedReview?.status).toBe('completed');
    expect(storedReview?.error_message).toBeNull();
  });

  it('dispatches pending one-slot work after stale running work stops consuming capacity', async () => {
    const pendingTimestamp = minutesAgo(1);
    const staleRunningTimestamp = minutesAgo(91);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);

    const [staleRunningReview, pendingReview] = await db
      .insert(cloud_agent_code_reviews)
      .values([
        reviewValues({
          owner,
          status: 'running',
          createdAt: staleRunningTimestamp,
          updatedAt: staleRunningTimestamp,
          startedAt: staleRunningTimestamp,
        }),
        reviewValues({
          owner,
          status: 'pending',
          createdAt: pendingTimestamp,
          updatedAt: pendingTimestamp,
        }),
      ])
      .returning({ id: cloud_agent_code_reviews.id });

    if (!staleRunningReview || !pendingReview) {
      throw new Error('Expected stale running and pending reviews to be inserted');
    }

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const storedStaleRunningReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, staleRunningReview.id),
    });
    const storedPendingReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, pendingReview.id),
    });

    expect(result).toEqual({ dispatched: 1, notDispatched: 0, activeCount: 1 });
    expect(storedStaleRunningReview?.status).toBe('running');
    expect(storedPendingReview?.status).toBe('queued');
  });

  it('does not count stale running reviews against owner capacity', async () => {
    const recentTimestamp = minutesAgo(1);
    const staleRunningTimestamp = minutesAgo(91);
    const owner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;

    await db.insert(cloud_agent_code_reviews).values([
      reviewValues({
        owner,
        status: 'running',
        createdAt: recentTimestamp,
        updatedAt: recentTimestamp,
        startedAt: recentTimestamp,
      }),
      ...Array.from({ length: 19 }, () =>
        reviewValues({
          owner,
          status: 'queued',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      ),
      reviewValues({
        owner,
        status: 'running',
        createdAt: staleRunningTimestamp,
        updatedAt: staleRunningTimestamp,
        startedAt: staleRunningTimestamp,
      }),
    ]);

    const result = await tryDispatchPendingReviews({
      type: 'org',
      id: testOrganizationId,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 0,
      notDispatched: 0,
      activeCount: 20,
    });
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('does not claim a review that was cancelled as superseded before dispatch', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;

    await db.insert(cloud_agent_code_reviews).values({
      ...reviewValues({
        owner,
        status: 'pending',
        createdAt: recentTimestamp,
        updatedAt: recentTimestamp,
      }),
      pr_number: 99,
      head_sha: 'sha-old',
    });

    await cancelSupersededReviewsForPR(REPO, 99, 'sha-new');

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 0,
      notDispatched: 0,
      activeCount: 0,
    });
    expect(mockDispatchReview).not.toHaveBeenCalled();

    const [review] = await db
      .select({
        status: cloud_agent_code_reviews.status,
        terminalReason: cloud_agent_code_reviews.terminal_reason,
      })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.pr_number, 99))
      .limit(1);

    expect(review?.status).toBe('cancelled');
    expect(review?.terminalReason).toBe('superseded');
  });

  it('does not dispatch a review that is superseded after claim', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        ...reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        }),
        pr_number: 100,
        head_sha: 'sha-race-old',
      })
      .returning({ id: cloud_agent_code_reviews.id });

    if (!review) {
      throw new Error('Expected review to be inserted');
    }

    mockPrepareReviewPayload.mockImplementationOnce(async (params: { reviewId: string }) => {
      queueMicrotask(() => {
        void cancelSupersededReviewsForPR(REPO, 100, 'sha-race-new');
      });
      return { reviewId: params.reviewId };
    });

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });

    expect(result).toEqual({
      dispatched: 0,
      notDispatched: 1,
      activeCount: 0,
    });
    expect(mockDispatchReview).not.toHaveBeenCalled();
    expect(storedReview?.status).toBe('cancelled');
    expect(storedReview?.terminal_reason).toBe('superseded');
  });
  it('does not count stale queued reviews against owner capacity', async () => {
    const recentTimestamp = minutesAgo(1);
    const staleQueuedTimestamp = minutesAgo(6);
    const owner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;

    await db.insert(cloud_agent_code_reviews).values([
      ...Array.from({ length: 20 }, () =>
        reviewValues({
          owner,
          status: 'running',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
          startedAt: recentTimestamp,
        })
      ),
      reviewValues({
        owner,
        status: 'queued',
        createdAt: staleQueuedTimestamp,
        updatedAt: staleQueuedTimestamp,
      }),
    ]);

    const result = await tryDispatchPendingReviews({
      type: 'org',
      id: testOrganizationId,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 0,
      notDispatched: 0,
      activeCount: 20,
    });
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('prioritizes fresh pending reviews over older stale queued recovery reviews', async () => {
    const staleQueuedCreatedAt = minutesAgo(30);
    const staleQueuedUpdatedAt = minutesAgo(6);
    const pendingCreatedAt = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);

    const insertedReviews = await db
      .insert(cloud_agent_code_reviews)
      .values([
        reviewValues({
          owner,
          status: 'queued',
          createdAt: staleQueuedCreatedAt,
          updatedAt: staleQueuedUpdatedAt,
        }),
        reviewValues({
          owner,
          status: 'pending',
          createdAt: pendingCreatedAt,
          updatedAt: pendingCreatedAt,
        }),
      ])
      .returning({ id: cloud_agent_code_reviews.id });
    const staleQueuedReview = insertedReviews[0];
    const pendingReview = insertedReviews[1];

    if (!staleQueuedReview || !pendingReview) {
      throw new Error('Expected stale queued and pending reviews to be inserted');
    }

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    expect(result).toEqual({
      dispatched: 1,
      notDispatched: 0,
      activeCount: 1,
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
    expect(mockPrepareReviewPayload).toHaveBeenCalledWith({
      reviewId: pendingReview.id,
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      agentConfig: { id: 'test-agent-config', config: {}, is_enabled: true, runtime_state: {} },
      platform: 'github',
    });
    expect(mockPrepareReviewPayload).not.toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: staleQueuedReview.id })
    );
  });

  it('keeps a dispatch timeout claimed when the Worker status probe finds queued DO state', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);
    mockDispatchReview.mockRejectedValue(new Error('Request timeout after 10000ms'));
    mockGetReviewStatus.mockResolvedValue({ reviewId: 'unused', status: 'queued' });

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    if (!review) {
      throw new Error('Expected review to be inserted');
    }

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });

    expect(result).toEqual({
      dispatched: 1,
      notDispatched: 0,
      activeCount: 1,
    });
    const [attempt] = await db
      .select({ id: cloud_agent_code_review_attempts.id })
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, review.id))
      .limit(1);
    expect(mockGetReviewStatus).toHaveBeenCalledWith(review.id, attempt?.id);
    expect(storedReview?.status).toBe('queued');
  });

  it('releases a dispatch timeout claim when the Worker status probe finds no DO state', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);
    mockDispatchReview.mockRejectedValue(new Error('Request timeout after 10000ms'));
    mockGetReviewStatus.mockResolvedValue(null);

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    if (!review) {
      throw new Error('Expected review to be inserted');
    }

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });

    expect(result).toEqual({
      dispatched: 0,
      notDispatched: 1,
      activeCount: 0,
    });
    const [attempt] = await db
      .select({ id: cloud_agent_code_review_attempts.id })
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, review.id))
      .limit(1);
    expect(mockGetReviewStatus).toHaveBeenCalledWith(review.id, attempt?.id);
    expect(storedReview?.status).toBe('pending');
  });

  it('keeps a dispatch timeout claim when the Worker status probe also fails', async () => {
    const recentTimestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);
    mockDispatchReview.mockRejectedValue(new Error('Request timeout after 10000ms'));
    mockGetReviewStatus.mockRejectedValue(new Error('status probe timeout'));

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          status: 'pending',
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    if (!review) {
      throw new Error('Expected review to be inserted');
    }

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });

    expect(result).toEqual({
      dispatched: 0,
      notDispatched: 1,
      activeCount: 0,
    });
    const [attempt] = await db
      .select({ id: cloud_agent_code_review_attempts.id })
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, review.id))
      .limit(1);
    expect(mockGetReviewStatus).toHaveBeenCalledWith(review.id, attempt?.id);
    expect(storedReview?.status).toBe('queued');
  });

  it('sends the current attempt id to the worker dispatch payload', async () => {
    const timestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          status: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const [attempt] = await db
      .select({ id: cloud_agent_code_review_attempts.id })
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, review.id))
      .limit(1);

    expect(mockDispatchReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: review.id, attemptId: attempt?.id })
    );
  });

  it('mirrors terminal worker dispatch responses', async () => {
    const timestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);
    mockDispatchReview.mockRejectedValue(
      new Error("Dispatch returned terminal status 'failed' for review terminal-review")
    );
    mockGetReviewStatus.mockResolvedValue({ reviewId: 'unused', status: 'failed' });

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          status: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    const result = await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const storedReview = await db.query.cloud_agent_code_reviews.findFirst({
      where: eq(cloud_agent_code_reviews.id, review.id),
    });
    const storedAttempt = await db.query.cloud_agent_code_review_attempts.findFirst({
      where: eq(cloud_agent_code_review_attempts.code_review_id, review.id),
    });

    expect(result).toEqual({
      dispatched: 1,
      notDispatched: 0,
      activeCount: 1,
    });
    expect(storedReview?.status).toBe('failed');
    expect(storedAttempt?.status).toBe('failed');
  });
});
