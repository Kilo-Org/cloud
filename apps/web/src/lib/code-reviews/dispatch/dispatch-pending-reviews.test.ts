jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual('@/lib/config.server'),
  ISOLATE_REVIEW_WORKER_URL: 'https://isolate.test',
}));

const mockFlag = jest.fn();
const mockFlagPayload = jest.fn();
const mockPrepareIsolate = jest.fn();
const mockSnapshot = jest.fn();
const mockAfterAcquire = jest.fn();
const mockAfterReviewRead = jest.fn();
const mockBeforeCancellation = jest.fn();
const mockCancelReview = jest.fn();
const mockCreateCheckRun = jest.fn();
const mockFinalizeCheck = jest.fn();
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    pulls: {
      get: async () => ({
        data: { state: 'open', head: { sha: 'a'.repeat(40) }, base: { repo: { full_name: REPO } } },
      }),
    },
    checks: {
      get: async ({ check_run_id }: { check_run_id: number }) => ({
        data: { id: check_run_id, head_sha: 'a'.repeat(40), app: { id: 123 } },
      }),
      update: (...args: unknown[]) => mockFinalizeCheck(...args),
    },
  })),
}));
jest.mock('@/lib/integrations/platforms/github/app-selector', () => ({
  getGitHubAppCredentials: () => ({ appId: '123' }),
  getGitHubAppName: () => 'KiloConnect',
}));
jest.mock('../db/publication-fences', () => {
  const actual = jest.requireActual('../db/publication-fences');
  return {
    ...actual,
    acquireIsolatePublicationFence: async (...args: unknown[]) => {
      const result = await actual.acquireIsolatePublicationFence(...args);
      await mockAfterAcquire(result);
      return result;
    },
  };
});

jest.mock('@/lib/posthog', () => ({
  __esModule: true,
  default: () => ({
    getFeatureFlag: (...args: unknown[]) => mockFlag(...args),
    getFeatureFlagPayload: (...args: unknown[]) => mockFlagPayload(...args),
  }),
  shutdownPosthog: jest.fn(),
}));
jest.mock('../triggers/prepare-isolate-review-payload', () => ({
  prepareIsolateReviewPayload: (...args: unknown[]) => mockPrepareIsolate(...args),
  fetchIsolateReviewSnapshot: (...args: unknown[]) => mockSnapshot(...args),
}));

const mockDispatchReview = jest.fn();
const mockGetReviewStatus = jest.fn();
const mockGetAgentConfigForOwner = jest.fn();
const mockPrepareReviewPayload = jest.fn();
const mockSendCodeReviewDisabledEmail = jest.fn();
const mockGetIntegrationById = jest.fn();
const mockUpdateCheckRun = jest.fn();
const mockLogExceptInTest = jest.fn();
const mockReviewIsStillReserved = jest.fn();

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    dispatchReview: (...args: unknown[]) => mockDispatchReview(...args),
    getReviewStatus: (...args: unknown[]) => mockGetReviewStatus(...args),
    cancelReview: (...args: unknown[]) => mockCancelReview(...args),
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
  createCheckRun: (...args: unknown[]) => mockCreateCheckRun(...args),
  generateGitHubInstallationToken: jest.fn().mockResolvedValue({ token: 'fixture-only' }),
}));

jest.mock('@/lib/constants', () => ({
  APP_URL: 'https://test.kilo.ai',
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  startSpan: (_context: unknown, callback: () => unknown) => callback(),
  trpcMiddleware:
    () =>
    ({ next }: { next: () => unknown }) =>
      next(),
  setTag: jest.fn(),
}));

jest.mock('@/lib/utils.server', () => ({
  ...jest.requireActual<typeof utilsServer>('@/lib/utils.server'),
  logExceptInTest: (...args: unknown[]) => mockLogExceptInTest(...args),
}));

jest.mock('@/lib/code-reviews/db/code-reviews', () => {
  const actual = jest.requireActual<typeof codeReviewsDb>('../db/code-reviews');
  return {
    ...actual,
    reviewIsStillReserved: (...args: unknown[]) => mockReviewIsStillReserved(...args),
    getCodeReviewById: async (...args: Parameters<typeof actual.getCodeReviewById>) => {
      const review = await actual.getCodeReviewById(...args);
      await mockAfterReviewRead(review);
      return review;
    },
    getLatestCodeReviewAttempt: async (
      ...args: Parameters<typeof actual.getLatestCodeReviewAttempt>
    ) => {
      const attempt = await actual.getLatestCodeReviewAttempt(...args);
      await mockBeforeCancellation(attempt);
      return attempt;
    },
    prepareCodeReviewCancellation: async (reviewId: string) => {
      await mockBeforeCancellation(await actual.getLatestCodeReviewAttempt(reviewId));
      return actual.prepareCodeReviewCancellation(reviewId);
    },
  };
});

import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { codeReviewRouter } from '@/routers/code-reviews/code-reviews-router';
import { admitCodeReviewAttemptForDispatch, createCodeReviewAttempt } from '../db/code-reviews';
import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { handleQueuedIsolateCallback } from '../queued-isolate-lifecycle';
import { cancelCodeReview, resetCodeReviewForRetry } from '../db/code-reviews';
import type * as utilsServer from '@/lib/utils.server';
import type * as codeReviewsDb from '../db/code-reviews';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { generateBotUserId } from '@/lib/bot-users/types';
import {
  agent_configs,
  organization_memberships,
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  organizations,
  platform_integrations,
  type User,
} from '@kilocode/db/schema';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { IsolateReviewRequestSchema } from '@/lib/isolate-review-worker-client';
import {
  QueuedIsolateIdentitySchema,
  type QueuedIsolateIdentity,
} from '../queued-isolate-contract';
import {
  recordIsolatePublicationSafety,
  releaseIsolatePublicationFence,
  requestIsolateIdentityCleanup,
  setIsolateWebFinalization,
  publicationFromAttempt,
} from '../db/publication-fences';
import {
  getCodeReviewById,
  getLatestCodeReviewAttempt,
  updateReviewHeadShaAndCheckRun,
  listDispatchableCodeReviewOwnerCandidates,
} from '../db/code-reviews';
import { recoverQueuedIsolateReviews } from '../client/queued-isolate-review-client';
import { reapStaleCodeReviews } from '../reap-stale-reviews';
import { or } from 'drizzle-orm';
import { tryDispatchPendingReviews } from './dispatch-pending-reviews';
import { cronPendingCodeReviewCreatedAtWindowSql } from './dispatch-constants';
import { appendCodeReviewAnalyticsPromptAppendix } from '../analytics/contracts';
import type { CodeReviewPayload } from '../triggers/prepare-review-payload';
import type * as reviewPayloadPreparation from '../triggers/prepare-review-payload';
import {
  cancelSupersededReviewsForPR,
  updateRepositoryReviewInstructionsMetadata,
} from '../db/code-reviews';

const REPO = `test-org/dispatch-pending-${Date.now()}`;
const FUNDED_BALANCE_MICRODOLLARS = 5_000_001;
const DEFAULT_TIER_BALANCE_MICRODOLLARS = 5_000_000;
const DISPATCH_PROMPT_DIAGNOSTICS_MESSAGE = '[dispatchReview] Worker dispatch prompt diagnostics';

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
  let userIntegrationId: string;
  let organizationIntegrationId: string;
  let reviewSequence = 0;

  beforeAll(async () => {
    testUser = await insertTestUser();
    const [organization] = await db
      .insert(organizations)
      .values({ name: `Dispatch Pending Reviews ${Date.now()}` })
      .returning({ id: organizations.id });
    testOrganizationId = organization.id;
    await db
      .insert(organization_memberships)
      .values({ organization_id: testOrganizationId, kilo_user_id: testUser.id, role: 'member' });
    const [userIntegration, organizationIntegration] = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_user_id: testUser.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: `dispatch-user-${Date.now()}`,
          platform_account_id: 'dispatch-user',
          platform_account_login: 'dispatch-user',
          repository_access: 'all',
          integration_status: 'active',
        },
        {
          owned_by_organization_id: testOrganizationId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: `dispatch-org-${Date.now()}`,
          platform_account_id: 'dispatch-org',
          platform_account_login: 'dispatch-org',
          repository_access: 'all',
          integration_status: 'active',
        },
      ])
      .returning({ id: platform_integrations.id });
    if (!userIntegration || !organizationIntegration) {
      throw new Error('Expected dispatch review integrations');
    }
    userIntegrationId = userIntegration.id;
    organizationIntegrationId = organizationIntegration.id;
  });

  beforeEach(() => {
    mockFlag.mockReset().mockResolvedValue(false);
    mockFlagPayload.mockReset().mockResolvedValue({ organizationIds: [testOrganizationId] });
    mockPrepareIsolate.mockReset();
    mockAfterAcquire.mockReset().mockResolvedValue(undefined);
    mockAfterReviewRead.mockReset().mockResolvedValue(undefined);
    mockBeforeCancellation.mockReset().mockResolvedValue(undefined);
    mockCancelReview
      .mockReset()
      .mockImplementation(
        jest.requireActual('../client/code-review-worker-client').codeReviewWorkerClient
          .cancelReview
      );
    mockCreateCheckRun.mockReset().mockResolvedValue(77);
    mockFinalizeCheck.mockReset().mockImplementation(async ({ check_run_id, ...data }) => ({
      data: { id: check_run_id, ...data },
    }));
    mockSnapshot
      .mockReset()
      .mockImplementation(({ expectedHeadSha }: { expectedHeadSha: string }) => ({
        headSha: expectedHeadSha,
        baseTipSha: 'b'.repeat(40),
        mergeBaseSha: 'c'.repeat(40),
      }));
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
      sessionInput: { prompt: 'Review this change.' },
    }));
    mockSendCodeReviewDisabledEmail.mockResolvedValue({ sent: true });
    mockGetIntegrationById.mockResolvedValue(null);
    mockUpdateCheckRun.mockResolvedValue(undefined);
    mockReviewIsStillReserved.mockImplementation(
      jest.requireActual<typeof codeReviewsDb>('../db/code-reviews').reviewIsStillReserved
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db
      .delete(cloud_agent_code_reviews)
      .where(inArray(cloud_agent_code_reviews.repo_full_name, [REPO, REPO.toUpperCase()]));
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
    mockLogExceptInTest.mockReset();
    mockReviewIsStillReserved.mockReset();
  });

  afterAll(async () => {
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, testOrganizationId));
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
    platform = 'github',
  }: {
    owner: ReviewOwner;
    status: ReviewStatus;
    createdAt: string;
    updatedAt: string;
    startedAt?: string | null;
    platform?: 'github' | 'bitbucket';
  }) {
    const sequence = reviewSequence++;

    return {
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      owned_by_organization_id: owner.type === 'org' ? owner.id : null,
      platform_integration_id:
        owner.type === 'user' ? userIntegrationId : organizationIntegrationId,
      repo_full_name: REPO,
      pr_number: sequence + 1,
      pr_url: `https://github.com/${REPO}/pull/${sequence + 1}`,
      pr_title: `Test PR ${sequence + 1}`,
      pr_author: 'octocat',
      base_ref: 'main',
      head_ref: `feature/test-${sequence}`,
      head_sha: `sha-${sequence}`,
      platform,
      status,
      started_at: startedAt,
      created_at: createdAt,
      updated_at: updatedAt,
    };
  }

  function userReviewScope(prNumber: number) {
    return {
      owner: { type: 'user' as const, id: testUser.id, userId: testUser.id },
      platform: 'github' as const,
      repoFullName: REPO,
      prNumber,
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
        model: cloud_agent_code_reviews.model,
      })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId))
      .limit(1);

    return review;
  }

  async function getStoredPublication(reviewId: string, identity?: QueuedIsolateIdentity) {
    const [attempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(
        and(
          eq(cloud_agent_code_review_attempts.code_review_id, reviewId),
          identity ? eq(cloud_agent_code_review_attempts.id, identity.attemptId) : undefined
        )
      )
      .orderBy(desc(cloud_agent_code_review_attempts.attempt_number))
      .limit(1);
    const publication = attempt ? publicationFromAttempt(attempt) : null;
    if (!publication) throw new Error('Missing isolate publication');
    if (identity) expect(publication.generation).toBe(identity.generation);
    return publication;
  }

  function orgOwner() {
    return { type: 'org' as const, id: testOrganizationId, userId: testUser.id };
  }

  async function optIn() {
    mockFlag.mockResolvedValue(true);
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, organizationIntegrationId));
    mockGetIntegrationById.mockResolvedValue(integration);
    mockPrepareIsolate.mockImplementation(
      async ({ identity }: { identity: QueuedIsolateIdentity }) => {
        const [owner, repo] = identity.target.repoFullName.split('/');
        const review = IsolateReviewRequestSchema.parse({
          owner,
          repo,
          pullNumber: identity.target.prNumber,
          organizationId: identity.organizationId,
          ...identity.snapshot,
          model: 'fixture/model',
          expectedIntegrationId: identity.integrationId,
          expectedInstallationId: integration.platform_installation_id,
          expectedAppType: 'standard',
          dryRun: false,
          userPrompt: 'Canonical policy',
          preparation: {
            version: 1,
            preparedAt: new Date().toISOString(),
            requestingUserId: identity.executionUserId,
            executionUserId: identity.executionUserId,
            organizationId: identity.organizationId,
            queued: { identity, gateThreshold: 'off', summaryHistory: '' },
            settings: {
              reviewStyle: 'balanced',
              focusAreas: [],
              customInstructions: null,
              manualInstructions: null,
              model: 'fixture/model',
              thinkingEffort: null,
              modelSource: 'global',
              disableReviewMd: true,
              analyticsEnabled: false,
            },
            snapshot: identity.snapshot,
            github: {
              integrationId: identity.integrationId,
              installationId: integration.platform_installation_id,
              appType: 'standard',
            },
            hashes: {
              settings: 'a'.repeat(64),
              context: 'b'.repeat(64),
              canonicalPrompt: 'c'.repeat(64),
              adaptedPrompt: 'd'.repeat(64),
              system: 'e'.repeat(64),
            },
            versions: { cli: '7.4.20', policy: 'fixture', adapter: 'fixture' },
            limitations: [],
          },
        });
        return {
          review,
          admission: {
            version: 1,
            runId: identity.attemptId,
            identity,
            preparationHash: createHash('sha256').update(JSON.stringify(review)).digest('hex'),
          },
          authToken: 'fixture-only',
        };
      }
    );
    mockDispatchReview.mockImplementation(
      async (payload: { admission?: { identity: QueuedIsolateIdentity }; reviewId?: string }) => ({
        reviewId: payload.admission?.identity.reviewId ?? payload.reviewId,
        status: 'queued',
      })
    );
  }

  async function candidate(overrides: Partial<typeof cloud_agent_code_reviews.$inferInsert> = {}) {
    const values = {
      ...reviewValues({
        owner: orgOwner(),
        status: 'pending',
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      }),
      head_sha: 'a'.repeat(40),
      ...overrides,
    };
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        ...values,
        pr_url:
          overrides.pr_url ??
          `https://github.com/${values.repo_full_name}/pull/${values.pr_number}`,
      })
      .returning();
    return review;
  }

  it('pins an eligible new attempt to isolate before dispatch and binds canonical preparation', async () => {
    await optIn();
    const review = await candidate();
    expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({ dispatched: 1 });
    const attempt = await getLatestCodeReviewAttempt(review.id);
    expect(attempt).toMatchObject({
      reviewer_backend: 'isolate',
      reviewer_execution_id: attempt?.id,
    });
    expect(mockPrepareReviewPayload).not.toHaveBeenCalled();
    expect(mockDispatchReview).toHaveBeenCalledWith(
      expect.objectContaining({ admission: expect.objectContaining({ runId: attempt?.id }) })
    );
    const fence = await getStoredPublication(review.id);
    expect(fence.preparation?.hash).toBe(
      mockDispatchReview.mock.calls[0][0].admission.preparationHash
    );
    expect(await updateReviewHeadShaAndCheckRun(review.id, 'd'.repeat(40), 999)).toBe(false);
    expect(
      (
        await db
          .select()
          .from(cloud_agent_code_reviews)
          .where(eq(cloud_agent_code_reviews.id, review.id))
      )[0].head_sha
    ).toBe(review.head_sha);
  });

  it.each([
    ['gitlab', 'standard', false],
    ['bitbucket', 'standard', false],
    ['github', 'council', false],
    ['github', 'standard', true],
  ] as const)(
    'keeps unsupported context %s %s personal=%s on legacy without flag lookup',
    async (platform, reviewType, personal) => {
      await optIn();
      const review = await candidate({
        platform,
        review_type: reviewType,
        ...(personal
          ? {
              owned_by_user_id: testUser.id,
              owned_by_organization_id: null,
              platform_integration_id: userIntegrationId,
            }
          : {}),
      });
      await tryDispatchPendingReviews(
        personal ? { type: 'user', id: testUser.id, userId: testUser.id } : orgOwner()
      );
      expect((await getLatestCodeReviewAttempt(review.id))?.reviewer_backend).toBe('legacy');
      expect(mockFlag).not.toHaveBeenCalled();
      expect(mockPrepareIsolate).not.toHaveBeenCalled();
      expect(mockDispatchReview).toHaveBeenCalledWith(
        expect.objectContaining({ reviewId: review.id })
      );
    }
  );

  it.each([false, undefined, null, 'true'])('fails closed for flag %s', async flag => {
    await optIn();
    mockFlag.mockResolvedValue(flag);
    const review = await candidate();
    await tryDispatchPendingReviews(orgOwner());
    expect((await getLatestCodeReviewAttempt(review.id))?.reviewer_backend).toBe('legacy');
    expect(mockPrepareIsolate).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { organizationIds: [] },
    { organizationIds: ['invalid'] },
    { organizationIds: 'invalid' },
  ])('fails closed for malformed or absent membership %j', async payload => {
    await optIn();
    mockFlagPayload.mockResolvedValue(payload);
    const review = await candidate();
    await tryDispatchPendingReviews(orgOwner());
    expect((await getLatestCodeReviewAttempt(review.id))?.reviewer_backend).toBe('legacy');
    expect(mockPrepareIsolate).not.toHaveBeenCalled();
  });

  it('keeps reclaimed historical queued work on legacy but permits future opt-in work on the same PR', async () => {
    await optIn();
    const historical = await candidate({ status: 'queued', updated_at: minutesAgo(10) });
    await tryDispatchPendingReviews(orgOwner());
    expect((await getLatestCodeReviewAttempt(historical.id))?.reviewer_backend).toBe('legacy');
    expect(mockFlag).not.toHaveBeenCalled();
    await cancelSupersededReviewsForPR(
      { owner: orgOwner(), platform: 'github', repoFullName: REPO, prNumber: historical.pr_number },
      'd'.repeat(40)
    );
    const next = await candidate({ pr_number: historical.pr_number, head_sha: 'd'.repeat(40) });
    await tryDispatchPendingReviews(orgOwner());
    expect((await getLatestCodeReviewAttempt(next.id))?.reviewer_backend).toBe('isolate');
  });

  it.each([true, false])(
    'blocks a separate successor before selection with rollout=%s, then recovers beyond the cron window',
    async enabled => {
      await optIn();
      const first = await candidate();
      await tryDispatchPendingReviews(orgOwner());
      const fence = await getStoredPublication(first.id);
      await recordIsolatePublicationSafety({
        identity: fence.identity,
        safety: {
          sequence: 1,
          execution: 'cancelled',
          cancellationRequested: true,
          publication: 'uncertain',
          quiescent: false,
          observedAt: new Date().toISOString(),
        },
      });
      await cancelSupersededReviewsForPR(
        { owner: orgOwner(), platform: 'github', repoFullName: REPO, prNumber: first.pr_number },
        'd'.repeat(40)
      );
      const next = await candidate({
        pr_number: first.pr_number,
        head_sha: 'd'.repeat(40),
        created_at: minutesAgo(4000),
        updated_at: minutesAgo(4000),
      });
      mockFlag.mockResolvedValue(enabled);
      mockDispatchReview.mockClear();
      mockFlag.mockClear();
      mockPrepareIsolate.mockClear();
      mockPrepareReviewPayload.mockClear();
      expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({
        dispatched: 0,
        notDispatched: 1,
      });
      expect(await getStoredReview(next.id)).toMatchObject({
        status: 'pending',
        dispatchReservationId: null,
      });
      expect((await getLatestCodeReviewAttempt(next.id))?.reviewer_backend).toBe('unselected');
      expect((await getCodeReviewById(next.id))?.blocked_by_attempt_id).toBe(fence.attempt_id);
      expect(mockFlag).not.toHaveBeenCalled();
      expect(mockDispatchReview).not.toHaveBeenCalled();
      expect(mockPrepareIsolate).not.toHaveBeenCalled();
      expect(await releaseIsolatePublicationFence(fence.identity)).toBe(false);
      const unrelated = await candidate();
      expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({ dispatched: 1 });
      expect((await getLatestCodeReviewAttempt(unrelated.id))?.reviewer_backend).toBe(
        enabled ? 'isolate' : 'legacy'
      );
      await db
        .update(cloud_agent_code_reviews)
        .set({ updated_at: minutesAgo(4000) })
        .where(eq(cloud_agent_code_reviews.id, next.id));
      expect(await reapStaleCodeReviews()).toMatchObject({ terminalized: 0 });
      expect(
        (
          await listDispatchableCodeReviewOwnerCandidates({
            pendingCreatedAtWindow: cronPendingCodeReviewCreatedAtWindowSql(),
          })
        ).owners
      ).toEqual([]);
      await recordIsolatePublicationSafety({
        identity: fence.identity,
        safety: {
          sequence: 2,
          execution: 'cancelled',
          cancellationRequested: true,
          publication: 'settled',
          quiescent: true,
          observedAt: new Date().toISOString(),
        },
      });
      await setIsolateWebFinalization({
        identity: fence.identity,
        expected: 'pending',
        state: 'suppressed',
      });
      expect(await releaseIsolatePublicationFence(fence.identity)).toBe(true);
      expect(await reapStaleCodeReviews()).toMatchObject({ terminalized: 0 });
      expect(
        (
          await listDispatchableCodeReviewOwnerCandidates({
            pendingCreatedAtWindow: cronPendingCodeReviewCreatedAtWindowSql(),
          })
        ).owners
      ).toContainEqual({ type: 'org', id: testOrganizationId });
      expect((await getCodeReviewById(next.id))?.blocked_by_attempt_id).toBe(fence.attempt_id);
      mockDispatchReview.mockClear();
      expect(
        await tryDispatchPendingReviews(orgOwner(), {
          pendingCreatedAtWindow: cronPendingCodeReviewCreatedAtWindowSql(),
        })
      ).toMatchObject({ dispatched: 1 });
      expect((await getLatestCodeReviewAttempt(next.id))?.reviewer_backend).toBe(
        enabled ? 'isolate' : 'legacy'
      );
      expect(mockDispatchReview).toHaveBeenCalledTimes(1);
      expect((await getCodeReviewById(next.id))?.blocked_by_attempt_id).toBeNull();
      expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({ dispatched: 0 });
    }
  );

  it('retains released blocker readiness through capacity waits and repeated owner discovery', async () => {
    await optIn();
    const holder = await candidate();
    await tryDispatchPendingReviews(orgOwner());
    const publication = await getStoredPublication(holder.id);
    await cancelCodeReview(holder.id, publication.attempt_id);
    const successor = await candidate({
      pr_number: holder.pr_number,
      head_sha: 'd'.repeat(40),
      created_at: minutesAgo(4000),
    });
    expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({
      dispatched: 0,
      notDispatched: 1,
    });
    await recordIsolatePublicationSafety({
      identity: publication.identity,
      safety: {
        sequence: 1,
        execution: 'cancelled',
        cancellationRequested: true,
        publication: 'not_started',
        quiescent: true,
        observedAt: new Date().toISOString(),
      },
    });
    await setIsolateWebFinalization({
      identity: publication.identity,
      expected: 'pending',
      state: 'suppressed',
    });
    expect(await releaseIsolatePublicationFence(publication.identity)).toBe(true);
    const active = await Promise.all(
      Array.from({ length: 20 }, () => candidate({ status: 'running', started_at: minutesAgo(1) }))
    );
    const options = { pendingCreatedAtWindow: cronPendingCodeReviewCreatedAtWindowSql() };
    mockDispatchReview.mockClear();
    expect(await tryDispatchPendingReviews(orgOwner(), options)).toEqual({
      dispatched: 0,
      notDispatched: 0,
      activeCount: 20,
    });
    expect(await listDispatchableCodeReviewOwnerCandidates(options)).toEqual({
      owners: [],
      hasMore: false,
    });
    expect((await getCodeReviewById(successor.id))?.blocked_by_attempt_id).toBe(
      publication.attempt_id
    );
    await db
      .update(cloud_agent_code_reviews)
      .set({ status: 'completed' })
      .where(eq(cloud_agent_code_reviews.id, active[0].id));
    const waiting = await getCodeReviewById(successor.id);
    for (let pass = 0; pass < 2; pass++) {
      expect(await listDispatchableCodeReviewOwnerCandidates(options)).toEqual({
        owners: [{ type: 'org', id: testOrganizationId }],
        hasMore: false,
      });
      expect(await getCodeReviewById(successor.id)).toEqual(waiting);
    }
    mockFlag.mockResolvedValue(false);
    expect(await tryDispatchPendingReviews(orgOwner(), options)).toMatchObject({ dispatched: 1 });
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
    expect(mockDispatchReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: successor.id })
    );
    expect((await getCodeReviewById(successor.id))?.blocked_by_attempt_id).toBeNull();
  });

  it('refills a full blocked batch without reviving pending work outside the cron window', async () => {
    await optIn();
    const holders = await Promise.all(Array.from({ length: 20 }, () => candidate()));
    expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({ dispatched: 20 });
    await Promise.all(
      holders.map(async holder => {
        const attempt = await getLatestCodeReviewAttempt(holder.id);
        await cancelCodeReview(holder.id, attempt?.id);
      })
    );
    const blocked = await Promise.all(
      holders.map(holder =>
        candidate({
          pr_number: holder.pr_number,
          head_sha: 'd'.repeat(40),
          created_at: minutesAgo(70),
        })
      )
    );
    const ready = await candidate({ created_at: minutesAgo(65) });
    const historical = await candidate({ created_at: minutesAgo(4000) });
    const recent = await candidate({ created_at: minutesAgo(30) });
    mockFlag.mockResolvedValue(false);
    mockDispatchReview.mockClear();

    expect(
      await tryDispatchPendingReviews(orgOwner(), {
        pendingCreatedAtWindow: cronPendingCodeReviewCreatedAtWindowSql(),
      })
    ).toEqual({ dispatched: 1, notDispatched: 20, activeCount: 1 });
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
    expect(mockDispatchReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: ready.id })
    );
    expect(await getStoredReview(historical.id)).toMatchObject({ status: 'pending' });
    expect(await getStoredReview(recent.id)).toMatchObject({ status: 'pending' });
    expect(
      await db
        .select()
        .from(cloud_agent_code_reviews)
        .where(
          and(
            inArray(
              cloud_agent_code_reviews.id,
              blocked.map(review => review.id)
            ),
            isNotNull(cloud_agent_code_reviews.blocked_by_attempt_id)
          )
        )
    ).toHaveLength(20);
  });

  it('does not retry an ambiguous dispatch while refilling a publication-blocked slot', async () => {
    await optIn();
    const first = await candidate();
    await tryDispatchPendingReviews(orgOwner());
    const attempt = await getLatestCodeReviewAttempt(first.id);
    await cancelCodeReview(first.id, attempt?.id);
    await Promise.all(
      Array.from({ length: 18 }, () => candidate({ status: 'running', started_at: minutesAgo(1) }))
    );
    const blocked = await candidate({
      pr_number: first.pr_number,
      head_sha: 'd'.repeat(40),
      created_at: minutesAgo(70),
    });
    const ambiguous = await candidate({ created_at: minutesAgo(69) });
    const ready = await candidate({ created_at: minutesAgo(65) });
    mockFlag.mockResolvedValue(false);
    mockDispatchReview
      .mockReset()
      .mockImplementation(async ({ reviewId }: { reviewId: string }) => {
        if (reviewId === ambiguous.id) throw new Error('Lost response');
        return { reviewId, status: 'queued' };
      });

    expect(await tryDispatchPendingReviews(orgOwner())).toEqual({
      dispatched: 1,
      notDispatched: 2,
      activeCount: 19,
    });
    expect(mockDispatchReview.mock.calls.map(([payload]) => payload.reviewId)).toEqual([
      ambiguous.id,
      ready.id,
    ]);
    expect(mockGetReviewStatus).toHaveBeenCalledTimes(1);
    expect(await getStoredReview(blocked.id)).toMatchObject({ status: 'pending' });
    expect(await getStoredReview(ambiguous.id)).toMatchObject({
      status: 'pending',
      dispatchReservationId: null,
    });
  });

  it('bounds blocked refills and leaves remaining candidates for the next drain', async () => {
    await optIn();
    const holders = await Promise.all(Array.from({ length: 3 }, () => candidate()));
    expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({ dispatched: 3 });
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);
    const userFields = {
      owned_by_user_id: testUser.id,
      owned_by_organization_id: null,
      platform_integration_id: userIntegrationId,
    };
    const blocked = await Promise.all(
      holders.map((holder, index) =>
        candidate({
          ...userFields,
          pr_number: holder.pr_number,
          head_sha: 'd'.repeat(40),
          created_at: minutesAgo(70 - index),
        })
      )
    );
    const ready = await candidate({ ...userFields, created_at: minutesAgo(65) });
    mockDispatchReview.mockClear();
    const owner = { type: 'user' as const, id: testUser.id, userId: testUser.id };

    expect(await tryDispatchPendingReviews(owner)).toEqual({
      dispatched: 0,
      notDispatched: 2,
      activeCount: 0,
    });
    expect(mockDispatchReview).not.toHaveBeenCalled();
    expect(await getLatestCodeReviewAttempt(blocked[2].id)).toBeNull();
    expect(await getLatestCodeReviewAttempt(ready.id)).toBeNull();
    expect(await tryDispatchPendingReviews(owner)).toEqual({
      dispatched: 1,
      notDispatched: 1,
      activeCount: 1,
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
    expect(mockDispatchReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: ready.id })
    );
  });

  it.each(['finalization', 'identity-cleanup', 'stale-dispatch'] as const)(
    'preserves the cron window through %s recovery while waking recorded blocked successors',
    async path => {
      await optIn();
      const first = await candidate();
      const predecessor = path === 'stale-dispatch' ? await candidate() : first;
      await tryDispatchPendingReviews(orgOwner());
      const fences = await Promise.all(
        [...new Set([first.id, predecessor.id])].map(reviewId => getStoredPublication(reviewId))
      );
      const predecessorAttempt = await getLatestCodeReviewAttempt(predecessor.id);
      await cancelCodeReview(predecessor.id, predecessorAttempt?.id);
      const successor = await candidate({
        pr_number: predecessor.pr_number,
        head_sha: 'd'.repeat(40),
        created_at: minutesAgo(4000),
      });
      expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({
        dispatched: 0,
        notDispatched: 1,
      });
      for (const fence of fences) {
        await recordIsolatePublicationSafety({
          identity: fence.identity,
          safety: {
            sequence: 1,
            execution: 'cancelled',
            cancellationRequested: true,
            publication: 'not_started',
            quiescent: true,
            observedAt: new Date().toISOString(),
          },
        });
        await setIsolateWebFinalization({
          identity: fence.identity,
          expected: 'pending',
          state: 'suppressed',
        });
        if (path === 'identity-cleanup')
          await db.transaction(tx => requestIsolateIdentityCleanup(tx, testUser.id));
        expect(await releaseIsolatePublicationFence(fence.identity)).toBe(true);
        await db
          .update(cloud_agent_code_review_attempts)
          .set({ updated_at: minutesAgo(1) })
          .where(eq(cloud_agent_code_review_attempts.id, fence.attempt_id));
      }
      if (path === 'stale-dispatch')
        await db
          .update(cloud_agent_code_reviews)
          .set({ updated_at: minutesAgo(10) })
          .where(eq(cloud_agent_code_reviews.id, first.id));
      const historical = await candidate({ created_at: minutesAgo(4000) });
      const recent = await candidate({ created_at: minutesAgo(30) });
      const eligible = await candidate({ created_at: minutesAgo(65) });
      const bot = await insertTestUser({
        id: generateBotUserId(testOrganizationId, 'code-review'),
        is_bot: true,
      });
      try {
        await db.insert(organization_memberships).values({
          organization_id: testOrganizationId,
          kilo_user_id: bot.id,
          role: 'member',
        });
        mockFlag.mockResolvedValue(false);
        mockDispatchReview.mockClear();
        const options = { pendingCreatedAtWindow: cronPendingCodeReviewCreatedAtWindowSql() };
        if (path === 'stale-dispatch') await tryDispatchPendingReviews(orgOwner(), options);
        else await recoverQueuedIsolateReviews(options);

        expect(await getStoredReview(successor.id)).toMatchObject({ status: 'queued' });
        expect(await getStoredReview(eligible.id)).toMatchObject({ status: 'queued' });
        expect(await getStoredReview(historical.id)).toMatchObject({
          status: 'pending',
          dispatchReservationId: null,
        });
        expect(await getStoredReview(recent.id)).toMatchObject({
          status: 'pending',
          dispatchReservationId: null,
        });
        expect(await getLatestCodeReviewAttempt(historical.id)).toBeNull();
        expect(await getLatestCodeReviewAttempt(recent.id)).toBeNull();
        expect(mockDispatchReview).toHaveBeenCalledTimes(2);
        expect(await getStoredPublication(first.id)).toMatchObject({
          queue_wakeup_at: expect.any(String),
        });
      } finally {
        await db
          .delete(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, testOrganizationId),
              eq(organization_memberships.kilo_user_id, bot.id)
            )
          );
        await db.delete(kilocode_users).where(eq(kilocode_users.id, bot.id));
      }
    }
  );

  it('recovers ambiguous admission using pinned controls, without reconfiguration or legacy fallback', async () => {
    await optIn();
    const review = await candidate();
    mockDispatchReview.mockRejectedValue(new Error('Lost admission response'));
    const transport = jest.spyOn(global, 'fetch').mockImplementation(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      return Response.json({
        version: 1,
        identity: body.identity,
        safety: {
          sequence: 1,
          execution: 'running',
          cancellationRequested: false,
          publication: 'pending',
          quiescent: false,
          observedAt: new Date().toISOString(),
        },
      });
    });
    expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({ dispatched: 1 });
    const attempt = await getLatestCodeReviewAttempt(review.id);
    mockFlag.mockResolvedValue(false);
    mockFlag.mockClear();
    mockGetAgentConfigForOwner.mockResolvedValue({ is_enabled: false, config: {} });
    await db
      .update(cloud_agent_code_reviews)
      .set({ updated_at: minutesAgo(10) })
      .where(eq(cloud_agent_code_reviews.id, review.id));
    expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({ dispatched: 1 });
    expect((await getLatestCodeReviewAttempt(review.id))?.id).toBe(attempt?.id);
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
    expect(mockPrepareIsolate).toHaveBeenCalledTimes(1);
    expect(mockPrepareReviewPayload).not.toHaveBeenCalled();
    expect(mockFlag).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('retains the pinned fence after unavailable status and uses a tombstone for an absent ambiguous admission', async () => {
    await optIn();
    const review = await candidate();
    mockDispatchReview.mockRejectedValue(new Error('Lost response'));
    const transport = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unavailable'));
    expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({ dispatched: 0 });
    const attempt = await getLatestCodeReviewAttempt(review.id);
    const fence = await getStoredPublication(review.id);
    expect(fence.released_at).toBeNull();
    transport.mockResolvedValue(new Response(null, { status: 404 }));
    await db
      .update(cloud_agent_code_reviews)
      .set({ updated_at: minutesAgo(10) })
      .where(eq(cloud_agent_code_reviews.id, review.id));
    await db
      .update(cloud_agent_code_review_attempts)
      .set({ updated_at: minutesAgo(1) })
      .where(eq(cloud_agent_code_review_attempts.id, fence.attempt_id));
    await recoverQueuedIsolateReviews();
    expect(
      transport.mock.calls.slice(-2).map(([, init]) => JSON.parse(String(init?.body)).operation)
    ).toEqual(['status', 'cancel']);
    expect((await getLatestCodeReviewAttempt(review.id))?.id).toBe(attempt?.id);
    expect(await releaseIsolatePublicationFence(fence.identity)).toBe(false);
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
    expect(mockPrepareReviewPayload).not.toHaveBeenCalled();
  });

  it('rechecks a legacy successor after preparation if an isolate fence appeared meanwhile', async () => {
    await optIn();
    mockFlag.mockResolvedValue(false);
    const legacy = await candidate({ repo_full_name: REPO.toUpperCase() });
    const prepared = createDeferred<void>();
    const resume = createDeferred<void>();
    mockPrepareReviewPayload.mockImplementationOnce(async () => {
      prepared.resolve();
      await resume.promise;
      return { reviewId: legacy.id, sessionInput: { prompt: 'Legacy policy' } };
    });
    const firstDispatch = tryDispatchPendingReviews(orgOwner());
    await prepared.promise;
    mockFlag.mockResolvedValue(true);
    const isolate = await candidate({ pr_number: legacy.pr_number, head_sha: 'd'.repeat(40) });
    expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({ dispatched: 1 });
    resume.resolve();
    expect(await firstDispatch).toMatchObject({ dispatched: 0, notDispatched: 1 });
    expect((await getLatestCodeReviewAttempt(legacy.id))?.reviewer_backend).toBe('legacy');
    expect((await getLatestCodeReviewAttempt(isolate.id))?.reviewer_backend).toBe('isolate');
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
    expect(await getStoredReview(legacy.id)).toMatchObject({
      status: 'pending',
      dispatchReservationId: null,
    });
  });

  it('does not migrate a selected legacy attempt after enablement', async () => {
    await optIn();
    mockFlag.mockResolvedValue(false);
    const review = await candidate();
    await tryDispatchPendingReviews(orgOwner());
    const original = await getLatestCodeReviewAttempt(review.id);
    mockFlag.mockResolvedValue(true).mockClear();
    await db
      .update(cloud_agent_code_reviews)
      .set({ updated_at: minutesAgo(10) })
      .where(eq(cloud_agent_code_reviews.id, review.id));
    await tryDispatchPendingReviews(orgOwner());
    expect(await getLatestCodeReviewAttempt(review.id)).toMatchObject({
      id: original?.id,
      reviewer_backend: 'legacy',
    });
    expect(mockPrepareIsolate).not.toHaveBeenCalled();
    expect(mockFlag).not.toHaveBeenCalled();
  });

  it('keeps GitHub Lite on legacy because queued isolate requires the standard app', async () => {
    await optIn();
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, organizationIntegrationId));
    mockGetIntegrationById.mockResolvedValue({ ...integration, github_app_type: 'lite' });
    const review = await candidate();
    expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({ dispatched: 1 });
    expect((await getLatestCodeReviewAttempt(review.id))?.reviewer_backend).toBe('legacy');
    expect(mockPrepareIsolate).not.toHaveBeenCalled();
  });

  it('fails the selected legacy attempt when payload preparation cannot load its integration', async () => {
    const review = await candidate();
    const { prepareReviewPayload } = jest.requireActual<typeof reviewPayloadPreparation>(
      '../triggers/prepare-review-payload'
    );
    mockPrepareReviewPayload.mockImplementationOnce(prepareReviewPayload);
    mockGetIntegrationById.mockImplementationOnce(async () => {
      expect(await getLatestCodeReviewAttempt(review.id)).toMatchObject({
        status: 'pending',
        reviewer_backend: 'legacy',
      });
      return null;
    });

    expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({
      dispatched: 0,
      notDispatched: 1,
    });
    const errorMessage = `Dispatch failed: Provider Code Reviewer job ${review.id} integration is unavailable`;
    expect(await getStoredReview(review.id)).toMatchObject({
      status: 'failed',
      dispatchReservationId: null,
      errorMessage,
    });
    expect(await getLatestCodeReviewAttempt(review.id)).toMatchObject({
      status: 'failed',
      reviewer_backend: 'legacy',
      error_message: errorMessage,
      completed_at: expect.any(String),
    });
    expect(mockPrepareReviewPayload).toHaveBeenCalledTimes(1);
    expect(mockGetIntegrationById).toHaveBeenCalledTimes(1);
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('recovers a failed pinned preparation by cancelling only that attempt, without releasing its fence', async () => {
    await optIn();
    const review = await candidate();
    mockPrepareIsolate.mockRejectedValue(new Error('Invalid preparation'));
    expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({ dispatched: 0 });
    const attempt = await getLatestCodeReviewAttempt(review.id);
    expect(attempt).toMatchObject({ status: 'failed', reviewer_backend: 'isolate' });
    const fence = await getStoredPublication(review.id);
    expect(fence.preparation).toBeNull();
    await db
      .update(cloud_agent_code_review_attempts)
      .set({ updated_at: minutesAgo(1) })
      .where(eq(cloud_agent_code_review_attempts.id, fence.attempt_id));
    const transport = jest.spyOn(global, 'fetch').mockResolvedValue(
      Response.json({
        version: 1,
        identity: fence.identity,
        safety: {
          sequence: 1,
          execution: 'cancelled',
          cancellationRequested: true,
          publication: 'not_started',
          quiescent: true,
          observedAt: new Date().toISOString(),
        },
      })
    );
    await recoverQueuedIsolateReviews();
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toMatchObject({
      operation: 'cancel',
      identity: { attemptId: attempt?.id },
    });
    expect(await releaseIsolatePublicationFence(fence.identity)).toBe(false);
    expect(mockDispatchReview).not.toHaveBeenCalled();
    expect(mockPrepareReviewPayload).not.toHaveBeenCalled();
  });

  it('bounds recovery and advances past unavailable isolate holders without discarding evidence', async () => {
    await optIn();
    const reviews = await Promise.all(Array.from({ length: 5 }, () => candidate()));
    expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({ dispatched: 5 });
    await db
      .update(cloud_agent_code_reviews)
      .set({ updated_at: minutesAgo(10) })
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
    await db
      .update(cloud_agent_code_review_attempts)
      .set({ updated_at: minutesAgo(1) })
      .where(
        inArray(
          cloud_agent_code_review_attempts.code_review_id,
          reviews.map(review => review.id)
        )
      );
    const transport = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unavailable'));
    await recoverQueuedIsolateReviews();
    expect(transport).toHaveBeenCalledTimes(4);
    await recoverQueuedIsolateReviews();
    expect(transport).toHaveBeenCalledTimes(5);
    const attempts = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(
        inArray(
          cloud_agent_code_review_attempts.code_review_id,
          reviews.map(review => review.id)
        )
      );
    expect(attempts).toHaveLength(5);
    expect(
      attempts.every(
        attempt =>
          attempt.publication_state?.released_at === null &&
          attempt.publication_state.preparation !== null
      )
    ).toBe(true);
  });

  async function terminalNotification(identity: QueuedIsolateIdentity, completedAt: string) {
    const token = await deriveCallbackToken({
      secret: INTERNAL_API_SECRET,
      scope: 'queued-isolate-callback',
      resourceParts: [JSON.stringify(QueuedIsolateIdentitySchema.parse(identity))],
    });
    const request = new NextRequest(
      `http://localhost/api/internal/code-review-status/${identity.reviewId}?attemptId=${identity.attemptId}`,
      {
        method: 'POST',
        headers: { 'X-Callback-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          identity,
          safety: {
            sequence: 1,
            execution: 'cancelled',
            cancellationRequested: true,
            publication: 'not_started',
            quiescent: true,
            observedAt: completedAt,
          },
          result: {
            reason: 'cancelled',
            completedAt,
            sessions: [{ sessionId: identity.attemptId, parentSessionId: null, requestCount: 0 }],
            summary: null,
            gateResult: null,
            analytics: { marker: null, omitted: false },
          },
        }),
      }
    );
    return handleQueuedIsolateCallback(request, identity.reviewId);
  }

  it.each([false, true])(
    'preserves live preparation and fences abandonment before a tombstone: expired=%s',
    async expired => {
      await optIn();
      const review = await candidate();
      const prepare = mockPrepareIsolate.getMockImplementation()!;
      const entered = createDeferred<QueuedIsolateIdentity>();
      const resume = createDeferred<void>();
      mockPrepareIsolate.mockImplementationOnce(async input => {
        entered.resolve(input.identity);
        await resume.promise;
        return prepare(input);
      });
      let completedAt = '';
      const transport = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
        completedAt = new Date().toISOString();
        const { identity } = JSON.parse(String(init?.body));
        return Response.json({
          version: 1,
          identity,
          safety: {
            sequence: 1,
            execution: 'cancelled',
            cancellationRequested: true,
            publication: 'not_started',
            quiescent: true,
            observedAt: completedAt,
          },
        });
      });
      const dispatch = tryDispatchPendingReviews(orgOwner());
      const identity = await entered.promise;
      try {
        await db
          .update(cloud_agent_code_review_attempts)
          .set({ updated_at: minutesAgo(1) })
          .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));
        await db
          .update(cloud_agent_code_reviews)
          .set({ updated_at: minutesAgo(expired ? 6 : 1) })
          .where(eq(cloud_agent_code_reviews.id, review.id));
        await recoverQueuedIsolateReviews();
        if (expired) {
          expect(await getStoredReview(review.id)).toMatchObject({
            status: 'failed',
            terminalReason: 'abandoned',
            dispatchReservationId: null,
          });
          expect(transport).toHaveBeenCalledTimes(1);
        } else {
          expect(transport.mock.calls.length).toBe(0);
          expect(await getStoredReview(review.id)).toMatchObject({ status: 'queued' });
        }
      } finally {
        resume.resolve();
        await dispatch;
      }
      if (!expired) {
        expect(mockDispatchReview).toHaveBeenCalledTimes(1);
        await cancelCodeReview(review.id, identity.attemptId);
        completedAt = new Date().toISOString();
      } else {
        expect(mockDispatchReview).not.toHaveBeenCalled();
        const fence = await getStoredPublication(identity.reviewId, identity);
        expect(fence.preparation).toBeNull();
      }
      expect((await terminalNotification(identity, completedAt)).status).toBe(200);
      const fence = await getStoredPublication(identity.reviewId, identity);
      expect(fence.released_at).not.toBeNull();
    }
  );

  it('does not let a cancelled preparer synchronize a retriggered successor attempt', async () => {
    await optIn();
    const review = await candidate();
    const entered = createDeferred<QueuedIsolateIdentity>();
    const resume = createDeferred<void>();
    mockAfterAcquire.mockImplementationOnce(async ({ fence }) => {
      entered.resolve(fence.identity);
      await resume.promise;
    });
    const dispatch = tryDispatchPendingReviews(orgOwner());
    const identity = await entered.promise;
    let successor: Awaited<ReturnType<typeof getLatestCodeReviewAttempt>>;
    try {
      await cancelCodeReview(review.id, identity.attemptId);
      await resetCodeReviewForRetry(review.id, { attemptId: identity.attemptId });
      successor = await getLatestCodeReviewAttempt(review.id);
    } finally {
      resume.resolve();
      await dispatch;
    }
    expect(await getLatestCodeReviewAttempt(review.id)).toMatchObject({
      id: successor!.id,
      reviewer_backend: 'unselected',
      status: 'pending',
      analytics_enabled_at_dispatch: null,
    });
    expect(mockPrepareIsolate).not.toHaveBeenCalled();
    expect(mockDispatchReview).not.toHaveBeenCalled();
    expect((await terminalNotification(identity, new Date().toISOString())).status).toBe(200);
    await tryDispatchPendingReviews(orgOwner());
    expect(await getLatestCodeReviewAttempt(review.id)).toMatchObject({
      id: successor!.id,
      reviewer_backend: 'isolate',
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('settles cancellation when unselected affinity becomes isolate before the cancellation decision', async () => {
    await optIn();
    const reservation = randomUUID();
    const review = await candidate({
      status: 'queued',
      dispatch_reservation_id: reservation,
      check_run_id: 77,
    });
    await admitCodeReviewAttemptForDispatch({
      codeReviewId: review.id,
      dispatchReservationId: reservation,
      previousStatus: 'pending',
    });
    const observed = createDeferred<void>();
    const resumeCancellation = createDeferred<void>();
    mockBeforeCancellation.mockImplementationOnce(async attempt => {
      expect(attempt.reviewer_backend).toBe('unselected');
      observed.resolve();
      await resumeCancellation.promise;
    });
    const preparing = createDeferred<QueuedIsolateIdentity>();
    const resumePreparation = createDeferred<void>();
    const prepare = mockPrepareIsolate.getMockImplementation()!;
    let completedAt = '';
    mockPrepareIsolate.mockImplementationOnce(async input => {
      preparing.resolve(input.identity);
      await resumePreparation.promise;
      const payload = await prepare(input);
      payload.review.preparation.preparedAt = new Date(
        Math.max(Date.now(), Date.parse(completedAt) + 1)
      ).toISOString();
      payload.admission.preparationHash = createHash('sha256')
        .update(JSON.stringify(payload.review))
        .digest('hex');
      return payload;
    });
    const transport = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      completedAt = new Date().toISOString();
      const { identity, operation } = JSON.parse(String(init?.body));
      expect(operation).toBe('cancel');
      return Response.json({
        version: 1,
        identity,
        safety: {
          sequence: 1,
          execution: 'cancelled',
          cancellationRequested: true,
          publication: 'not_started',
          quiescent: true,
          observedAt: completedAt,
        },
      });
    });
    const caller = codeReviewRouter.createCaller({ user: testUser });
    const cancellation = caller.cancel({ reviewId: review.id });
    await observed.promise;
    await db
      .update(cloud_agent_code_reviews)
      .set({ updated_at: minutesAgo(10) })
      .where(eq(cloud_agent_code_reviews.id, review.id));
    const dispatch = tryDispatchPendingReviews(orgOwner());
    const identity = await preparing.promise;
    try {
      resumeCancellation.resolve();
      expect(await cancellation).toMatchObject({ success: true });
    } finally {
      resumeCancellation.resolve();
      resumePreparation.resolve();
      await dispatch;
    }
    expect((await terminalNotification(identity, completedAt)).status).toBe(200);
    expect(await getStoredReview(review.id)).toMatchObject({ status: 'cancelled' });
    expect(mockDispatchReview).not.toHaveBeenCalled();
    expect(transport.mock.calls.length).toBe(1);
    expect(mockFinalizeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 77, status: 'completed', conclusion: 'cancelled' })
    );
    expect(mockFinalizeCheck).toHaveBeenCalledTimes(1);
    const fence = await getStoredPublication(identity.reviewId, identity);
    expect(fence.released_at).not.toBeNull();
    expect(fence.preparation).toBeNull();
  });

  it('prevents selection when cancellation wins the unselected attempt lock', async () => {
    await optIn();
    const reservation = randomUUID();
    const review = await candidate({
      status: 'queued',
      dispatch_reservation_id: reservation,
      check_run_id: 77,
    });
    await admitCodeReviewAttemptForDispatch({
      codeReviewId: review.id,
      dispatchReservationId: reservation,
      previousStatus: 'pending',
    });
    const transport = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('Unexpected network request'));
    const caller = codeReviewRouter.createCaller({ user: testUser });
    expect(await caller.cancel({ reviewId: review.id })).toMatchObject({ success: true });
    expect(await getLatestCodeReviewAttempt(review.id)).toMatchObject({
      status: 'cancelled',
      reviewer_backend: 'unselected',
    });
    expect(await tryDispatchPendingReviews(orgOwner())).toMatchObject({ dispatched: 0 });
    expect(transport.mock.calls.length).toBe(0);
    expect(mockPrepareIsolate).not.toHaveBeenCalled();
    expect(mockDispatchReview).not.toHaveBeenCalled();
    expect(mockUpdateCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      77,
      expect.objectContaining({ status: 'completed', conclusion: 'cancelled' }),
      'standard'
    );
    expect((await getLatestCodeReviewAttempt(review.id))?.publication_state).toBeNull();
  });

  it('keeps the winning retrigger pristine when a second retrigger resumes a stale terminal snapshot', async () => {
    await optIn();
    const startedAt = new Date(Date.now() - 60_000);
    const completedAt = new Date(Date.now() - 30_000);
    const review = await candidate({
      status: 'failed',
      session_id: 'agent-old',
      cli_session_id: 'ses-old',
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      error_message: 'Prior failure',
    });
    const source = await createCodeReviewAttempt({
      codeReviewId: review.id,
      status: 'failed',
      sessionId: 'agent-old',
      cliSessionId: 'ses-old',
      startedAt,
      completedAt,
      errorMessage: 'Prior failure',
    });
    const snapshotRead = createDeferred<void>();
    const resumeLoser = createDeferred<void>();
    mockAfterReviewRead.mockImplementationOnce(async () => {
      snapshotRead.resolve();
      await resumeLoser.promise;
    });
    const gateEntered = createDeferred<void>();
    const resumeWinner = createDeferred<void>();
    mockCreateCheckRun.mockImplementationOnce(async () => {
      gateEntered.resolve();
      await resumeWinner.promise;
      return 77;
    });
    const caller = codeReviewRouter.createCaller({ user: testUser });
    const loser = caller.retrigger({ reviewId: review.id }).then(
      value => value,
      error => error
    );
    await snapshotRead.promise;
    const winner = caller.retrigger({ reviewId: review.id });
    await gateEntered.promise;
    const successor = await getLatestCodeReviewAttempt(review.id);
    try {
      resumeLoser.resolve();
      expect(await loser).toMatchObject({ code: 'CONFLICT' });
      expect(await getLatestCodeReviewAttempt(review.id)).toMatchObject({
        id: successor!.id,
        retry_of_attempt_id: source.id,
        status: 'pending',
        reviewer_backend: 'unselected',
        session_id: null,
        cli_session_id: null,
        started_at: null,
        completed_at: null,
        error_message: null,
        analytics_enabled_at_dispatch: null,
      });
    } finally {
      resumeLoser.resolve();
      resumeWinner.resolve();
      await winner;
    }
    expect(await getLatestCodeReviewAttempt(review.id)).toMatchObject({
      id: successor!.id,
      status: 'queued',
      reviewer_backend: 'isolate',
    });
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
    expect(mockDispatchReview.mock.calls[0][0].admission.identity.attemptId).toBe(successor!.id);
  });

  it('dispatches pending Bitbucket work', async () => {
    const timestamp = minutesAgo(1);
    const owner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          platform: 'bitbucket',
          status: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    const result = await tryDispatchPendingReviews({
      type: 'org',
      id: testOrganizationId,
      userId: testUser.id,
    });

    expect(result).toEqual(expect.objectContaining({ dispatched: 1, notDispatched: 0 }));
    expect(await getStoredReview(review.id)).toEqual(
      expect.objectContaining({ status: 'queued', dispatchReservationId: expect.any(String) })
    );
    expect(mockGetAgentConfigForOwner).toHaveBeenCalledWith(
      { type: 'org', id: testOrganizationId, userId: testUser.id },
      'code_review',
      'bitbucket'
    );
    expect(mockPrepareReviewPayload).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: review.id, platform: 'bitbucket' })
    );
    expect(mockDispatchReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: review.id, skipBalanceCheck: true })
    );
  });

  it('persists the selected model when the review is dispatched', async () => {
    const timestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    mockPrepareReviewPayload.mockImplementation((params: { reviewId: string }) => ({
      reviewId: params.reviewId,
      sessionInput: { prompt: 'Review this change.', model: 'openai/gpt-5' },
    }));
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({ owner, status: 'pending', createdAt: timestamp, updatedAt: timestamp })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    await tryDispatchPendingReviews({ type: 'user', id: testUser.id, userId: testUser.id });

    expect(await getStoredReview(review.id)).toEqual(
      expect.objectContaining({ model: 'openai/gpt-5' })
    );
  });

  it('applies a per-repository model override to the dispatched config', async () => {
    const timestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    mockGetAgentConfigForOwner.mockResolvedValue({
      id: 'test-agent-config',
      config: {
        model_slug: 'anthropic/claude-sonnet-4.6',
        thinking_effort: null,
        repository_model_overrides: [
          {
            repository_id: 123,
            repo_full_name: REPO,
            model_slug: 'openai/gpt-5',
            thinking_effort: 'high',
          },
        ],
      },
      is_enabled: true,
      runtime_state: {},
    });

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({ owner, status: 'pending', createdAt: timestamp, updatedAt: timestamp })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    await tryDispatchPendingReviews({ type: 'user', id: testUser.id, userId: testUser.id });

    expect(mockPrepareReviewPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: review.id,
        agentConfig: expect.objectContaining({
          config: expect.objectContaining({
            model_slug: 'openai/gpt-5',
            thinking_effort: 'high',
          }),
        }),
      })
    );
  });

  it('uses the global model when no repository override matches', async () => {
    const timestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    mockGetAgentConfigForOwner.mockResolvedValue({
      id: 'test-agent-config',
      config: {
        model_slug: 'anthropic/claude-sonnet-4.6',
        thinking_effort: null,
        repository_model_overrides: [
          {
            repository_id: 999,
            repo_full_name: 'some-other-org/some-other-repo',
            model_slug: 'openai/gpt-5',
            thinking_effort: 'high',
          },
        ],
      },
      is_enabled: true,
      runtime_state: {},
    });

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({ owner, status: 'pending', createdAt: timestamp, updatedAt: timestamp })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    await tryDispatchPendingReviews({ type: 'user', id: testUser.id, userId: testUser.id });

    expect(mockPrepareReviewPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: review.id,
        agentConfig: expect.objectContaining({
          config: expect.objectContaining({ model_slug: 'anthropic/claude-sonnet-4.6' }),
        }),
      })
    );
  });

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

  it('disables only the Bitbucket config after a Bitbucket action-required failure', async () => {
    const timestamp = minutesAgo(1);
    const owner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;
    const [githubConfig, bitbucketConfig] = await db
      .insert(agent_configs)
      .values([
        {
          owned_by_organization_id: testOrganizationId,
          agent_type: 'code_review',
          platform: 'github',
          config: {},
          is_enabled: true,
          created_by: testUser.id,
        },
        {
          owned_by_organization_id: testOrganizationId,
          agent_type: 'code_review',
          platform: 'bitbucket',
          config: {},
          is_enabled: true,
          created_by: testUser.id,
        },
      ])
      .returning();
    mockGetAgentConfigForOwner.mockResolvedValue(bitbucketConfig);
    mockPrepareReviewPayload.mockRejectedValue(
      new Error('Selected model is not available for this cloud agent session')
    );
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          platform: 'bitbucket',
          status: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    await tryDispatchPendingReviews({
      type: 'org',
      id: testOrganizationId,
      userId: testUser.id,
    });

    const storedGithubConfig = await db.query.agent_configs.findFirst({
      where: eq(agent_configs.id, githubConfig.id),
    });
    const storedBitbucketConfig = await db.query.agent_configs.findFirst({
      where: eq(agent_configs.id, bitbucketConfig.id),
    });
    expect(storedGithubConfig?.is_enabled).toBe(true);
    expect(storedGithubConfig?.runtime_state).toEqual({});
    expect(storedBitbucketConfig?.is_enabled).toBe(false);
    expect(storedBitbucketConfig?.runtime_state).toEqual(
      expect.objectContaining({
        code_review_action_required: expect.objectContaining({
          reason: 'selected_model_unavailable',
          triggeringReviewId: review.id,
        }),
      })
    );
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
      return { reviewId: params.reviewId, sessionInput: { prompt: 'Review this change.' } };
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
      .where(inArray(cloud_agent_code_reviews.repo_full_name, [REPO, REPO.toUpperCase()]));
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
      return { reviewId: params.reviewId, sessionInput: { prompt: 'Review this change.' } };
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

    await cancelSupersededReviewsForPR(userReviewScope(99), 'sha-new');

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
        void cancelSupersededReviewsForPR(userReviewScope(100), 'sha-race-new');
      });
      return { reviewId: params.reviewId, sessionInput: { prompt: 'Review this change.' } };
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
    expect(mockLogExceptInTest).not.toHaveBeenCalledWith(
      DISPATCH_PROMPT_DIAGNOSTICS_MESSAGE,
      expect.anything()
    );
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

  it.each([
    { preference: true, persistedDecision: undefined, variant: 'max' },
    { preference: false, persistedDecision: undefined, variant: undefined },
    { preference: false, persistedDecision: true, variant: 'xhigh' },
    { preference: true, persistedDecision: false, variant: undefined },
  ])(
    'logs only actual dispatch prompt diagnostics with analytics preference=$preference, persisted=$persistedDecision',
    async ({ preference, persistedDecision, variant }) => {
      const timestamp = minutesAgo(1);
      const owner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;
      const preparedPrompt = 'Review this change: café.\n';
      const model = 'openai/gpt-5';
      const analyticsEnabled = persistedDecision ?? preference;
      mockGetAgentConfigForOwner.mockResolvedValue({
        id: 'test-agent-config',
        config: {
          review_analytics_enabled: preference,
          model_slug: 'anthropic/claude-sonnet-4.6',
          thinking_effort: 'high',
        },
        is_enabled: true,
        runtime_state: {},
      });
      mockPrepareReviewPayload.mockImplementation((params: { reviewId: string }) => ({
        reviewId: params.reviewId,
        authToken: 'test-dispatch-auth-token',
        sessionInput: {
          prompt: preparedPrompt,
          model,
          variant,
          githubToken: 'test-github-token',
        },
      }));

      const [review] = await db
        .insert(cloud_agent_code_reviews)
        .values(
          reviewValues({ owner, status: 'pending', createdAt: timestamp, updatedAt: timestamp })
        )
        .returning({ id: cloud_agent_code_reviews.id });
      if (persistedDecision !== undefined) {
        await db.insert(cloud_agent_code_review_attempts).values({
          code_review_id: review.id,
          attempt_number: 1,
          status: 'pending',
          analytics_enabled_at_dispatch: persistedDecision,
        });
      }

      await tryDispatchPendingReviews({ ...owner, userId: testUser.id });

      const [attempt] = await db
        .select()
        .from(cloud_agent_code_review_attempts)
        .where(eq(cloud_agent_code_review_attempts.code_review_id, review.id));
      const dispatchedPayload = mockDispatchReview.mock.calls[0]?.[0] as
        | CodeReviewPayload
        | undefined;
      if (!attempt || !dispatchedPayload) {
        throw new Error('Expected a persisted attempt and worker dispatch');
      }

      expect(mockPrepareReviewPayload).toHaveBeenCalledTimes(1);
      expect(mockDispatchReview).toHaveBeenCalledTimes(1);
      expect(attempt.analytics_enabled_at_dispatch).toBe(analyticsEnabled);
      expect(dispatchedPayload.sessionInput.prompt).toBe(
        analyticsEnabled ? appendCodeReviewAnalyticsPromptAppendix(preparedPrompt) : preparedPrompt
      );
      expect(
        mockLogExceptInTest.mock.calls.filter(
          ([message]) => message === DISPATCH_PROMPT_DIAGNOSTICS_MESSAGE
        )
      ).toEqual([
        [
          DISPATCH_PROMPT_DIAGNOSTICS_MESSAGE,
          {
            reviewId: review.id,
            attemptId: attempt.id,
            promptSha256: createHash('sha256')
              .update(dispatchedPayload.sessionInput.prompt, 'utf8')
              .digest('hex'),
            promptLength: dispatchedPayload.sessionInput.prompt.length,
            model,
            variant: variant ?? null,
            analytics_enabled_at_dispatch: analyticsEnabled,
            packagedCliVersion: '7.4.20',
          },
        ],
      ]);
    }
  );

  it.each(['admitted', 'cancelled', 'reclaimed'] as const)(
    'withholds prompt diagnostics until the final reservation recheck resolves: %s',
    async outcome => {
      const timestamp = minutesAgo(1);
      const owner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;
      const recheckStarted = createDeferred<void>();
      const releaseRecheck = createDeferred<void>();
      const { reviewIsStillReserved } =
        jest.requireActual<typeof codeReviewsDb>('../db/code-reviews');
      mockGetAgentConfigForOwner.mockResolvedValue({
        id: 'test-agent-config',
        config: { review_analytics_enabled: true },
        is_enabled: true,
        runtime_state: {},
      });
      mockReviewIsStillReserved
        .mockImplementationOnce(reviewIsStillReserved)
        .mockImplementationOnce(reviewIsStillReserved)
        .mockImplementationOnce(async (reviewId: string, reservationId: string) => {
          recheckStarted.resolve(undefined);
          await releaseRecheck.promise;
          return reviewIsStillReserved(reviewId, reservationId);
        });
      const [review] = await db
        .insert(cloud_agent_code_reviews)
        .values(
          reviewValues({ owner, status: 'pending', createdAt: timestamp, updatedAt: timestamp })
        )
        .returning({ id: cloud_agent_code_reviews.id });

      const dispatch = tryDispatchPendingReviews({ ...owner, userId: testUser.id });
      await recheckStarted.promise;

      expect(mockDispatchReview).not.toHaveBeenCalled();
      expect(mockLogExceptInTest).not.toHaveBeenCalledWith(
        DISPATCH_PROMPT_DIAGNOSTICS_MESSAGE,
        expect.anything()
      );
      const attempt = await db.query.cloud_agent_code_review_attempts.findFirst({
        where: eq(cloud_agent_code_review_attempts.code_review_id, review.id),
      });
      expect(attempt?.analytics_enabled_at_dispatch).toBe(true);

      if (outcome !== 'admitted') {
        await db
          .update(cloud_agent_code_reviews)
          .set(
            outcome === 'cancelled'
              ? { status: 'cancelled' }
              : { dispatch_reservation_id: randomUUID() }
          )
          .where(eq(cloud_agent_code_reviews.id, review.id));
      }
      releaseRecheck.resolve(undefined);
      const result = await dispatch;

      const dispatchCount = outcome === 'admitted' ? 1 : 0;
      expect(result).toEqual({
        dispatched: dispatchCount,
        notDispatched: 1 - dispatchCount,
        activeCount: dispatchCount,
      });
      expect(mockDispatchReview).toHaveBeenCalledTimes(dispatchCount);
      expect(
        mockLogExceptInTest.mock.calls.filter(
          ([message]) => message === DISPATCH_PROMPT_DIAGNOSTICS_MESSAGE
        )
      ).toHaveLength(dispatchCount);
      if (outcome === 'admitted') {
        const diagnosticCallIndex = mockLogExceptInTest.mock.calls.findIndex(
          ([message]) => message === DISPATCH_PROMPT_DIAGNOSTICS_MESSAGE
        );
        expect(mockLogExceptInTest.mock.invocationCallOrder[diagnosticCallIndex]).toBeLessThan(
          mockDispatchReview.mock.invocationCallOrder[0]
        );
      }
    }
  );

  it('forces analytics off for Bitbucket even when its stored config enables collection', async () => {
    const timestamp = minutesAgo(1);
    const owner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;
    mockGetAgentConfigForOwner.mockResolvedValue({
      id: 'test-bitbucket-agent-config',
      config: { review_analytics_enabled: true },
      is_enabled: true,
      runtime_state: {},
    });

    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          platform: 'bitbucket',
          status: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    await tryDispatchPendingReviews({
      type: 'org',
      id: testOrganizationId,
      userId: testUser.id,
    });

    const [attempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, review.id));
    const dispatchedPayload = mockDispatchReview.mock.calls[0]?.[0];

    expect(attempt?.analytics_enabled_at_dispatch).toBe(false);
    expect(dispatchedPayload.sessionInput.prompt).toBe('Review this change.');
  });

  it('ignores enabled analytics config for personal reviews', async () => {
    const timestamp = minutesAgo(1);
    const owner = { type: 'user', id: testUser.id } satisfies ReviewOwner;
    await setTestUserBalance(DEFAULT_TIER_BALANCE_MICRODOLLARS);
    mockGetAgentConfigForOwner.mockResolvedValue({
      id: 'test-agent-config',
      config: { review_analytics_enabled: true },
      is_enabled: true,
      runtime_state: {},
    });

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
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, review.id));
    const dispatchedPayload = mockDispatchReview.mock.calls[0]?.[0];

    expect(attempt?.analytics_enabled_at_dispatch).toBe(false);
    expect(dispatchedPayload.sessionInput.prompt).toBe('Review this change.');
  });

  it('ignores a legacy enabled analytics snapshot for personal reviews', async () => {
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
    await db.insert(cloud_agent_code_review_attempts).values({
      code_review_id: review.id,
      attempt_number: 1,
      status: 'pending',
      analytics_enabled_at_dispatch: true,
    });

    await tryDispatchPendingReviews({
      type: 'user',
      id: testUser.id,
      userId: testUser.id,
    });

    const dispatchedPayload = mockDispatchReview.mock.calls[0]?.[0];
    expect(dispatchedPayload.sessionInput.prompt).toBe('Review this change.');
    expect(mockLogExceptInTest).toHaveBeenCalledWith(
      DISPATCH_PROMPT_DIAGNOSTICS_MESSAGE,
      expect.objectContaining({
        analytics_enabled_at_dispatch: true,
        promptSha256: createHash('sha256').update('Review this change.', 'utf8').digest('hex'),
      })
    );
  });

  it('keeps an existing organization analytics snapshot after collection is disabled', async () => {
    const timestamp = minutesAgo(1);
    const owner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;

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
    await db.insert(cloud_agent_code_review_attempts).values({
      code_review_id: review.id,
      attempt_number: 1,
      status: 'pending',
      analytics_enabled_at_dispatch: true,
    });

    await tryDispatchPendingReviews({
      type: 'org',
      id: testOrganizationId,
      userId: testUser.id,
    });

    const dispatchedPayload = mockDispatchReview.mock.calls[0]?.[0];
    expect(dispatchedPayload.sessionInput.prompt).toContain('kilo-review-analytics:v1');
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
