import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cloud_agent_code_reviews,
  kilocode_users,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

const REPO = `test-org/admin-code-review-wait-${Date.now()}`;
const START_DATE = '2035-01-01';
const END_DATE = '2035-01-20';

type ReviewOwner = { type: 'user'; id: string } | { type: 'org'; id: string };
type FilterInput = {
  startDate: string;
  endDate: string;
  ownershipType?: 'all' | 'personal' | 'organization';
  agentVersion?: 'all' | 'v1' | 'v2';
};
type CodeReviewInsert = typeof cloud_agent_code_reviews.$inferInsert;

function filterInput(overrides: Partial<FilterInput> = {}): FilterInput {
  return {
    startDate: START_DATE,
    endDate: END_DATE,
    ownershipType: 'all',
    agentVersion: 'all',
    ...overrides,
  };
}

function timestamp(minutesFromDayStart: number): string {
  return new Date(Date.UTC(2035, 0, 10, 0, minutesFromDayStart)).toISOString();
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
  }: {
    owner: ReviewOwner;
    status: string;
    createdAt: string;
    updatedAt?: string;
    startedAt?: string | null;
    completedAt?: string | null;
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
