import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

const REPO = `test-org/admin-code-review-wait-${Date.now()}`;
const START_DATE = '2035-01-01T00:00:00.000Z';
const END_DATE = '2035-01-20T00:00:00.000Z';

type ReviewOwner = { type: 'user'; id: string } | { type: 'org'; id: string };
type FilterInput = {
  startDate: string;
  endDate: string;
  userId?: string;
  organizationId?: string;
  ownershipType?: 'all' | 'personal' | 'organization';
  retryAccountingMode?: 'final_outcome' | 'all_attempts';
};
type CodeReviewInsert = typeof cloud_agent_code_reviews.$inferInsert;

function filterInput(overrides: Partial<FilterInput> = {}): FilterInput {
  return {
    startDate: START_DATE,
    endDate: END_DATE,
    ownershipType: 'all',
    retryAccountingMode: 'final_outcome',
    ...overrides,
  };
}

function timestamp(minutesFromDayStart: number): string {
  return new Date(Date.UTC(2035, 0, 10, 0, minutesFromDayStart)).toISOString();
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

describe('adminCodeReviewsRouter', () => {
  let adminUser: User;
  let regularUser: User;
  let testOrganizationId = '';
  let reviewSequence = 0;

  beforeAll(async () => {
    adminUser = await insertTestUser({
      google_user_email: `admin-code-review-wait-${Date.now()}@example.com`,
      is_admin: true,
    });
    regularUser = await insertTestUser({
      google_user_email: `regular-code-review-wait-${Date.now()}@example.com`,
    });

    const [organization] = await db
      .insert(organizations)
      .values({ name: `Admin Code Review Wait ${Date.now()}` })
      .returning({ id: organizations.id });
    if (!organization) {
      throw new Error('Failed to create test organization');
    }
    testOrganizationId = organization.id;
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.repo_full_name, REPO));
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, testOrganizationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, adminUser.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, regularUser.id));
  });

  function reviewValues({
    owner,
    status,
    createdAt,
    updatedAt = createdAt,
    startedAt = null,
    completedAt = null,
    errorMessage = null,
    terminalReason = null,
  }: {
    owner: ReviewOwner;
    status: string;
    createdAt: string;
    updatedAt?: string;
    startedAt?: string | null;
    completedAt?: string | null;
    errorMessage?: string | null;
    terminalReason?: string | null;
  }): CodeReviewInsert {
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
      agent_version: 'v2',
      started_at: startedAt,
      completed_at: completedAt,
      error_message: errorMessage,
      terminal_reason: terminalReason,
      created_at: createdAt,
      updated_at: updatedAt,
    };
  }

  async function insertWaitMetricRows() {
    const personalOwner = { type: 'user', id: adminUser.id } satisfies ReviewOwner;
    const organizationOwner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;

    await db.insert(cloud_agent_code_reviews).values([
      reviewValues({
        owner: personalOwner,
        status: 'completed',
        createdAt: timestamp(720),
        startedAt: timestamp(720),
        completedAt: timestamp(740),
      }),
      reviewValues({
        owner: personalOwner,
        status: 'running',
        createdAt: timestamp(780),
        startedAt: timestamp(784),
      }),
      reviewValues({
        owner: personalOwner,
        status: 'pending',
        createdAt: timestamp(840),
      }),
      reviewValues({
        owner: personalOwner,
        status: 'running',
        createdAt: timestamp(900),
        startedAt: timestamp(899),
      }),
      reviewValues({
        owner: organizationOwner,
        status: 'completed',
        createdAt: timestamp(960),
        startedAt: timestamp(970),
        completedAt: timestamp(1000),
      }),
    ]);
  }

  it('computes overview wait metrics only from valid started reviews', async () => {
    await insertWaitMetricRows();

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.codeReviews.getOverviewStats(filterInput());

    expect(result.waitStartedCount).toBe(3);
    expect(result.avgWaitSeconds).toBeCloseTo(280);
    expect(result.p95WaitSeconds).toBeCloseTo(564);
    expect(result.p99WaitSeconds).toBeCloseTo(592.8);
    expect(result.maxWaitSeconds).toBeCloseTo(600);
    expect(result.waitWithinFiveMinuteRate).toBeCloseTo(66.67, 1);
  });

  it('filters sub-day intervals with an inclusive start and exclusive end', async () => {
    const personalOwner = { type: 'user', id: adminUser.id } satisfies ReviewOwner;

    await db
      .insert(cloud_agent_code_reviews)
      .values([
        reviewValues({ owner: personalOwner, status: 'pending', createdAt: timestamp(720) }),
        reviewValues({ owner: personalOwner, status: 'pending', createdAt: timestamp(750) }),
        reviewValues({ owner: personalOwner, status: 'pending', createdAt: timestamp(780) }),
      ]);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.codeReviews.getOverviewStats(
      filterInput({ startDate: timestamp(720), endDate: timestamp(780) })
    );

    expect(result.totalReviews).toBe(2);
  });

  it('rejects empty telemetry date intervals', async () => {
    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.codeReviews.getOverviewStats(
        filterInput({ startDate: timestamp(780), endDate: timestamp(780) })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects telemetry date intervals longer than 90 days', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const longInterval = filterInput({
      startDate: '2035-01-01T00:00:00.000Z',
      endDate: '2035-04-02T00:00:00.000Z',
    });

    await expect(caller.admin.codeReviews.getOverviewStats(longInterval)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller.admin.codeReviews.getErrorSessions({
        ...longInterval,
        errorMessage: 'Container shutdown: SIGTERM',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('counts recovered retries as final outcomes by default and separate attempts in all-attempts mode', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner: { type: 'user', id: adminUser.id },
          status: 'completed',
          createdAt: timestamp(600),
          startedAt: timestamp(602),
          completedAt: timestamp(640),
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    await db.insert(cloud_agent_code_review_attempts).values([
      {
        code_review_id: review.id,
        attempt_number: 1,
        status: 'failed',
        session_id: 'agent-failed-attempt',
        error_message: 'Container shutdown: SIGTERM',
        terminal_reason: 'sandbox_error',
        started_at: timestamp(602),
        completed_at: timestamp(610),
        created_at: timestamp(601),
      },
      {
        code_review_id: review.id,
        attempt_number: 2,
        retry_reason: 'infra_failure',
        status: 'completed',
        session_id: 'agent-completed-attempt',
        started_at: timestamp(612),
        completed_at: timestamp(640),
        created_at: timestamp(611),
      },
    ]);

    const caller = await createCallerForUser(adminUser.id);
    const finalOutcome = await caller.admin.codeReviews.getOverviewStats(filterInput());
    const allAttempts = await caller.admin.codeReviews.getOverviewStats(
      filterInput({ retryAccountingMode: 'all_attempts' })
    );

    expect(finalOutcome.totalReviews).toBe(1);
    expect(finalOutcome.completedCount).toBe(1);
    expect(finalOutcome.failedCount).toBe(0);
    expect(allAttempts.totalReviews).toBe(2);
    expect(allAttempts.completedCount).toBe(1);
    expect(allAttempts.failedCount).toBe(1);
  });

  it('includes recovered failed attempts in all-attempts error analysis and export', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner: { type: 'user', id: adminUser.id },
          status: 'completed',
          createdAt: timestamp(650),
          startedAt: timestamp(652),
          completedAt: timestamp(690),
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    await db.insert(cloud_agent_code_review_attempts).values([
      {
        code_review_id: review.id,
        attempt_number: 1,
        status: 'failed',
        session_id: 'agent-recovered-failure',
        error_message: 'Container shutdown: SIGTERM',
        terminal_reason: 'sandbox_error',
        created_at: timestamp(651),
        started_at: timestamp(652),
        completed_at: timestamp(660),
      },
      {
        code_review_id: review.id,
        attempt_number: 2,
        retry_reason: 'infra_failure',
        status: 'completed',
        session_id: 'agent-recovered-success',
        created_at: timestamp(661),
        started_at: timestamp(662),
        completed_at: timestamp(690),
      },
    ]);

    const caller = await createCallerForUser(adminUser.id);
    const finalErrors = await caller.admin.codeReviews.getErrorAnalysis(filterInput());
    const attemptErrors = await caller.admin.codeReviews.getErrorAnalysis(
      filterInput({ retryAccountingMode: 'all_attempts' })
    );
    const sessions = await caller.admin.codeReviews.getErrorSessions({
      ...filterInput({ retryAccountingMode: 'all_attempts' }),
      errorMessage: 'Container shutdown: SIGTERM',
    });
    const exportRows = await caller.admin.codeReviews.getExportData(
      filterInput({ retryAccountingMode: 'all_attempts' })
    );

    expect(finalErrors.details).toHaveLength(0);
    expect(attemptErrors.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ errorType: 'Container shutdown: SIGTERM', count: 1 }),
      ])
    );
    expect(sessions[0]).toMatchObject({
      reviewId: review.id,
      attemptNumber: 1,
      sessionId: 'agent-recovered-failure',
    });
    expect(exportRows[0]).toHaveProperty('attempt_id');
    expect(exportRows[0]).toHaveProperty('attempt_status');
  });

  it('classifies final model-not-found outcomes as cancellations instead of failures', async () => {
    const owner = { type: 'user', id: adminUser.id } satisfies ReviewOwner;

    await db.insert(cloud_agent_code_reviews).values([
      reviewValues({
        owner,
        status: 'failed',
        createdAt: timestamp(700),
        errorMessage: 'Model not found: kilo/retired-model',
      }),
      reviewValues({
        owner,
        status: 'cancelled',
        createdAt: timestamp(710),
        terminalReason: 'model_not_found',
        errorMessage: 'Model not found: kilo/retired-model',
      }),
      reviewValues({
        owner,
        status: 'failed',
        createdAt: timestamp(720),
        terminalReason: 'timeout',
        errorMessage: 'Execution timed out',
      }),
      reviewValues({ owner, status: 'completed', createdAt: timestamp(730) }),
    ]);

    const caller = await createCallerForUser(adminUser.id);
    const overview = await caller.admin.codeReviews.getOverviewStats(filterInput());
    const daily = await caller.admin.codeReviews.getDailyStats(filterInput());
    const cancellations = await caller.admin.codeReviews.getCancellationAnalysis(filterInput());
    const errors = await caller.admin.codeReviews.getErrorAnalysis(filterInput());
    const modelSessions = await caller.admin.codeReviews.getErrorSessions({
      ...filterInput(),
      errorMessage: 'Model not found: kilo/retired-model',
    });
    const segmentation = await caller.admin.codeReviews.getUserSegmentation(filterInput());

    expect(overview).toMatchObject({
      totalReviews: 4,
      completedCount: 1,
      failedCount: 1,
      cancelledCount: 2,
    });
    expect(daily[0]).toMatchObject({ completed: 1, failed: 1, cancelled: 2 });
    expect(cancellations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'Model no longer available', count: 2 }),
      ])
    );
    expect(errors.details).toEqual([
      expect.objectContaining({ errorType: 'Execution timed out', count: 1 }),
    ]);
    expect(modelSessions).toEqual([]);
    expect(segmentation.ownershipBreakdown[0]).toMatchObject({ failed: 1 });
  });

  it('buckets selected-model-unavailable terminal reasons as action required', async () => {
    const owner = { type: 'user', id: adminUser.id } satisfies ReviewOwner;
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner,
          status: 'failed',
          createdAt: timestamp(760),
          terminalReason: 'selected_model_unavailable',
          errorMessage: 'Selected model is not available for this cloud agent session',
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    await db.insert(cloud_agent_code_review_attempts).values({
      code_review_id: review.id,
      attempt_number: 1,
      status: 'failed',
      terminal_reason: 'selected_model_unavailable',
      error_message: 'Selected model is not available for this cloud agent session',
      created_at: timestamp(761),
      started_at: timestamp(762),
      completed_at: timestamp(763),
    });

    const caller = await createCallerForUser(adminUser.id);
    const finalErrors = await caller.admin.codeReviews.getErrorAnalysis(filterInput());
    const attemptErrors = await caller.admin.codeReviews.getErrorAnalysis(
      filterInput({ retryAccountingMode: 'all_attempts' })
    );

    expect(finalErrors.categories).toEqual([
      expect.objectContaining({ category: 'Action Required', count: 1 }),
    ]);
    expect(finalErrors.details).toEqual([
      expect.objectContaining({ category: 'Action Required', count: 1 }),
    ]);
    expect(attemptErrors.categories).toEqual([
      expect.objectContaining({ category: 'Action Required', count: 1 }),
    ]);
    expect(attemptErrors.details).toEqual([
      expect.objectContaining({ category: 'Action Required', count: 1 }),
    ]);
  });

  it('classifies all-attempt model-not-found outcomes as cancellations instead of failures', async () => {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(
        reviewValues({
          owner: { type: 'user', id: adminUser.id },
          status: 'completed',
          createdAt: timestamp(700),
          startedAt: timestamp(701),
          completedAt: timestamp(740),
        })
      )
      .returning({ id: cloud_agent_code_reviews.id });

    await db.insert(cloud_agent_code_review_attempts).values([
      {
        code_review_id: review.id,
        attempt_number: 1,
        status: 'failed',
        error_message: 'Model not found: kilo/retired-model',
        created_at: timestamp(701),
        started_at: timestamp(702),
        completed_at: timestamp(703),
      },
      {
        code_review_id: review.id,
        attempt_number: 2,
        status: 'cancelled',
        terminal_reason: 'model_not_found',
        error_message: 'Model not found: kilo/retired-model',
        created_at: timestamp(704),
        started_at: timestamp(705),
        completed_at: timestamp(706),
      },
      {
        code_review_id: review.id,
        attempt_number: 3,
        status: 'failed',
        terminal_reason: 'timeout',
        error_message: 'Execution timed out',
        created_at: timestamp(707),
        started_at: timestamp(708),
        completed_at: timestamp(709),
      },
      {
        code_review_id: review.id,
        attempt_number: 4,
        status: 'completed',
        created_at: timestamp(710),
        started_at: timestamp(711),
        completed_at: timestamp(740),
      },
    ]);

    const input = filterInput({ retryAccountingMode: 'all_attempts' });
    const caller = await createCallerForUser(adminUser.id);
    const overview = await caller.admin.codeReviews.getOverviewStats(input);
    const daily = await caller.admin.codeReviews.getDailyStats(input);
    const cancellations = await caller.admin.codeReviews.getCancellationAnalysis(input);
    const errors = await caller.admin.codeReviews.getErrorAnalysis(input);
    const modelSessions = await caller.admin.codeReviews.getErrorSessions({
      ...input,
      errorMessage: 'Model not found: kilo/retired-model',
    });
    const segmentation = await caller.admin.codeReviews.getUserSegmentation(input);

    expect(overview).toMatchObject({
      totalReviews: 4,
      completedCount: 1,
      failedCount: 1,
      cancelledCount: 2,
    });
    expect(daily[0]).toMatchObject({ completed: 1, failed: 1, cancelled: 2 });
    expect(cancellations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'Model no longer available', count: 2 }),
      ])
    );
    expect(errors.details).toEqual([
      expect.objectContaining({ errorType: 'Execution timed out', count: 1 }),
    ]);
    expect(modelSessions).toEqual([]);
    expect(segmentation.ownershipBreakdown[0]).toMatchObject({ failed: 1 });
  });

  it('returns ownership wait breakdown and daily trend series', async () => {
    await insertWaitMetricRows();

    const caller = await createCallerForUser(adminUser.id);
    const segmentation = await caller.admin.codeReviews.getUserSegmentation(filterInput());
    const trend = await caller.admin.codeReviews.getWaitTimeStats(filterInput());

    const personal = segmentation.ownershipBreakdown.find(row => row.type === 'personal');
    const organization = segmentation.ownershipBreakdown.find(row => row.type === 'organization');
    if (!personal || !organization) {
      throw new Error('Expected personal and organization ownership rows');
    }

    expect(personal.waitStartedCount).toBe(2);
    expect(personal.avgWaitSeconds).toBeCloseTo(120);
    expect(personal.p95WaitSeconds).toBeCloseTo(228);
    expect(organization.waitStartedCount).toBe(1);
    expect(organization.avgWaitSeconds).toBeCloseTo(600);
    expect(organization.p95WaitSeconds).toBeCloseTo(600);

    const personalTrend = trend.find(row => row.ownershipType === 'personal');
    const organizationTrend = trend.find(row => row.ownershipType === 'organization');
    if (!personalTrend || !organizationTrend) {
      throw new Error('Expected personal and organization wait trend rows');
    }

    expect(trend).toHaveLength(2);
    expect(personalTrend.day).toBe('2035-01-10');
    expect(personalTrend.count).toBe(2);
    expect(personalTrend.avgSeconds).toBeCloseTo(120);
    expect(personalTrend.p50Seconds).toBeCloseTo(120);
    expect(personalTrend.p95Seconds).toBeCloseTo(228);
    expect(organizationTrend.day).toBe('2035-01-10');
    expect(organizationTrend.count).toBe(1);
    expect(organizationTrend.avgSeconds).toBeCloseTo(600);
    expect(organizationTrend.p50Seconds).toBeCloseTo(600);
    expect(organizationTrend.p95Seconds).toBeCloseTo(600);
  });

  it('reports live queue health independent of date and retry filters while honoring owner filters', async () => {
    const personalOwner = { type: 'user', id: adminUser.id } satisfies ReviewOwner;
    const organizationOwner = { type: 'org', id: testOrganizationId } satisfies ReviewOwner;

    await db.insert(cloud_agent_code_reviews).values([
      reviewValues({
        owner: personalOwner,
        status: 'pending',
        createdAt: minutesAgo(12),
      }),
      reviewValues({
        owner: personalOwner,
        status: 'pending',
        createdAt: minutesAgo(2),
      }),
      reviewValues({
        owner: organizationOwner,
        status: 'queued',
        createdAt: minutesAgo(15),
        updatedAt: minutesAgo(6),
      }),
      reviewValues({
        owner: organizationOwner,
        status: 'queued',
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(2),
      }),
      reviewValues({
        owner: personalOwner,
        status: 'running',
        createdAt: minutesAgo(100),
        updatedAt: minutesAgo(91),
        startedAt: minutesAgo(91),
      }),
      reviewValues({
        owner: organizationOwner,
        status: 'running',
        createdAt: minutesAgo(10),
        updatedAt: minutesAgo(2),
        startedAt: minutesAgo(2),
      }),
      reviewValues({
        owner: organizationOwner,
        status: 'completed',
        createdAt: minutesAgo(20),
        completedAt: minutesAgo(19),
      }),
    ]);

    const caller = await createCallerForUser(adminUser.id);
    const globalQueue = await caller.admin.codeReviews.getQueueHealthStats(
      filterInput({ retryAccountingMode: 'all_attempts' })
    );
    const personalQueue = await caller.admin.codeReviews.getQueueHealthStats(
      filterInput({ ownershipType: 'personal' })
    );
    const userQueue = await caller.admin.codeReviews.getQueueHealthStats(
      filterInput({ userId: adminUser.id })
    );
    const organizationQueue = await caller.admin.codeReviews.getQueueHealthStats(
      filterInput({ organizationId: testOrganizationId })
    );

    expect(globalQueue).toMatchObject({
      pendingReviewCount: 2,
      pendingOverFiveMinutesCount: 1,
      staleQueuedClaimCount: 1,
      runningOverNinetyMinutesCount: 1,
      ownersWithWaitingReviewsCount: 2,
    });
    expect(globalQueue.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(11 * 60);
    expect(personalQueue).toMatchObject({
      pendingReviewCount: 2,
      pendingOverFiveMinutesCount: 1,
      staleQueuedClaimCount: 0,
      runningOverNinetyMinutesCount: 1,
      ownersWithWaitingReviewsCount: 1,
    });
    expect(userQueue).toMatchObject({
      pendingReviewCount: 2,
      pendingOverFiveMinutesCount: 1,
      staleQueuedClaimCount: 0,
      runningOverNinetyMinutesCount: 1,
      ownersWithWaitingReviewsCount: 1,
    });
    expect(organizationQueue).toMatchObject({
      pendingReviewCount: 0,
      pendingOverFiveMinutesCount: 0,
      staleQueuedClaimCount: 1,
      runningOverNinetyMinutesCount: 0,
      ownersWithWaitingReviewsCount: 1,
    });
  });

  it('returns zero-valued live queue health when no waiting work exists', async () => {
    const caller = await createCallerForUser(adminUser.id);

    await expect(caller.admin.codeReviews.getQueueHealthStats(filterInput())).resolves.toEqual({
      pendingReviewCount: 0,
      pendingOverFiveMinutesCount: 0,
      oldestPendingAgeSeconds: 0,
      staleQueuedClaimCount: 0,
      runningOverNinetyMinutesCount: 0,
      ownersWithWaitingReviewsCount: 0,
    });
  });

  it('requires admin access for live queue health stats', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.admin.codeReviews.getQueueHealthStats(filterInput())).rejects.toThrow(
      'Admin access required'
    );
  });

  it('requires admin access for wait time stats', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.admin.codeReviews.getWaitTimeStats(filterInput())).rejects.toThrow(
      'Admin access required'
    );
  });

  it('searches organizations by text without requiring a UUID query', async () => {
    const caller = await createCallerForUser(adminUser.id);

    const result = await caller.admin.codeReviews.searchOrganizations({
      query: 'Admin Code Review Wait',
    });

    expect(result.some(row => row.id === testOrganizationId)).toBe(true);
  });

  it('searches organizations by exact UUID', async () => {
    const caller = await createCallerForUser(adminUser.id);

    const result = await caller.admin.codeReviews.searchOrganizations({
      query: testOrganizationId,
    });

    expect(result.some(row => row.id === testOrganizationId)).toBe(true);
  });

  it('returns no organizations for whitespace-only search', async () => {
    const caller = await createCallerForUser(adminUser.id);

    const result = await caller.admin.codeReviews.searchOrganizations({ query: '   ' });

    expect(result).toEqual([]);
  });
});
