import { db, sql } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { cloud_agent_code_reviews, kilocode_users, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  evaluateErrorCategorySpike,
  evaluateFailureRate,
  evaluateNoCompletions,
  evaluateStuckReviews,
} from './detectors';

const REPO = `test-org/code-review-alerts-${Date.now()}`;
type CodeReviewInsert = typeof cloud_agent_code_reviews.$inferInsert;

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

describe('code review alert detectors', () => {
  let testUser: User;
  let reviewSequence = 0;

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  beforeEach(async () => {
    await db.delete(cloud_agent_code_reviews).where(sql`true`);
  });

  afterEach(async () => {
    await db.delete(cloud_agent_code_reviews).where(sql`true`);
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  function reviewValues(overrides: Partial<CodeReviewInsert> = {}) {
    const sequence = reviewSequence++;
    const timestamp = minutesAgo(5);

    return {
      owned_by_user_id: testUser.id,
      owned_by_organization_id: null,
      repo_full_name: REPO,
      pr_number: sequence + 1,
      pr_url: `https://github.com/${REPO}/pull/${sequence + 1}`,
      pr_title: `Test PR ${sequence + 1}`,
      pr_author: 'octocat',
      base_ref: 'main',
      head_ref: `feature/test-${sequence}`,
      head_sha: `sha-${sequence}`,
      status: 'completed',
      agent_version: 'v2',
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: timestamp,
      ...overrides,
    } satisfies CodeReviewInsert;
  }

  async function insertReviews(reviews: CodeReviewInsert[]): Promise<void> {
    await db.insert(cloud_agent_code_reviews).values(reviews);
  }

  it('does not trip failure rate at 25% and trips above 25%', async () => {
    await insertReviews([
      ...Array.from({ length: 2 }, () =>
        reviewValues({ status: 'failed', terminal_reason: 'timeout' })
      ),
      ...Array.from({ length: 6 }, () => reviewValues({ status: 'completed' })),
    ]);

    await expect(evaluateFailureRate(db)).resolves.toEqual({ tripped: false });

    await db.delete(cloud_agent_code_reviews).where(sql`true`);
    await insertReviews([
      ...Array.from({ length: 4 }, () =>
        reviewValues({ status: 'failed', terminal_reason: 'timeout' })
      ),
      ...Array.from({ length: 11 }, () => reviewValues({ status: 'completed' })),
    ]);

    await expect(evaluateFailureRate(db)).resolves.toMatchObject({
      tripped: true,
      details: {
        kind: 'failure_rate',
        failures: 4,
        total: 15,
        topReason: 'timeout',
        topReasonCount: 4,
      },
    });
  });

  it('requires at least eight terminal reviews for failure-rate alerts', async () => {
    await insertReviews(
      Array.from({ length: 7 }, () =>
        reviewValues({ status: 'failed', terminal_reason: 'upstream_error' })
      )
    );

    await expect(evaluateFailureRate(db)).resolves.toEqual({ tripped: false });
  });

  it('excludes benign terminal reasons from system failure counts', async () => {
    await insertReviews([
      reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
      reviewValues({ status: 'failed', terminal_reason: 'billing' }),
      reviewValues({ status: 'cancelled', terminal_reason: 'user_cancelled' }),
      reviewValues({ status: 'cancelled', terminal_reason: 'superseded' }),
      ...Array.from({ length: 5 }, () => reviewValues({ status: 'completed' })),
    ]);

    await expect(evaluateFailureRate(db)).resolves.toEqual({ tripped: false });
  });

  it('counts interrupted reviews as system failures', async () => {
    await insertReviews([
      ...Array.from({ length: 3 }, () =>
        reviewValues({ status: 'interrupted', terminal_reason: 'interrupted' })
      ),
      ...Array.from({ length: 6 }, () => reviewValues({ status: 'completed' })),
    ]);

    await expect(evaluateFailureRate(db)).resolves.toMatchObject({
      tripped: true,
      details: { kind: 'failure_rate', failures: 3, total: 9 },
    });
  });

  it('counts cancelled interrupted reviews as system failures', async () => {
    await insertReviews([
      ...Array.from({ length: 3 }, () =>
        reviewValues({ status: 'cancelled', terminal_reason: 'interrupted' })
      ),
      ...Array.from({ length: 6 }, () => reviewValues({ status: 'completed' })),
    ]);

    await expect(evaluateFailureRate(db)).resolves.toMatchObject({
      tripped: true,
      details: { kind: 'failure_rate', failures: 3, total: 9 },
    });
  });

  it('trips stuck-review alerts only at the count threshold', async () => {
    await insertReviews(
      Array.from({ length: 4 }, () =>
        reviewValues({ status: 'queued', created_at: minutesAgo(20), updated_at: minutesAgo(16) })
      )
    );
    await expect(evaluateStuckReviews(db)).resolves.toEqual({ tripped: false });

    await insertReviews([
      reviewValues({ status: 'queued', created_at: minutesAgo(20), updated_at: minutesAgo(16) }),
    ]);
    await expect(evaluateStuckReviews(db)).resolves.toMatchObject({
      tripped: true,
      details: { kind: 'stuck_reviews', queuedCount: 5, runningCount: 0 },
    });
  });

  it('detects stuck running reviews after two hours', async () => {
    await insertReviews(
      Array.from({ length: 5 }, () =>
        reviewValues({
          status: 'running',
          created_at: minutesAgo(130),
          updated_at: minutesAgo(10),
          started_at: minutesAgo(119),
          completed_at: null,
        })
      )
    );
    await expect(evaluateStuckReviews(db)).resolves.toEqual({ tripped: false });

    await db.delete(cloud_agent_code_reviews).where(sql`true`);
    await insertReviews(
      Array.from({ length: 5 }, () =>
        reviewValues({
          status: 'running',
          created_at: minutesAgo(130),
          updated_at: minutesAgo(10),
          started_at: minutesAgo(121),
          completed_at: null,
        })
      )
    );

    await expect(evaluateStuckReviews(db)).resolves.toMatchObject({
      tripped: true,
      details: { kind: 'stuck_reviews', queuedCount: 0, runningCount: 5 },
    });
  });

  it('still trips for reviews stuck running for more than six hours', async () => {
    await insertReviews(
      Array.from({ length: 5 }, () =>
        reviewValues({
          status: 'running',
          created_at: minutesAgo(60 * 8),
          updated_at: minutesAgo(60 * 7),
          started_at: minutesAgo(60 * 7),
          completed_at: null,
        })
      )
    );

    await expect(evaluateStuckReviews(db)).resolves.toMatchObject({
      tripped: true,
      details: { kind: 'stuck_reviews', queuedCount: 0, runningCount: 5 },
    });
  });

  it('guards no-completion alerts by minimum created count', async () => {
    await insertReviews(
      Array.from({ length: 4 }, () => reviewValues({ status: 'running', completed_at: null }))
    );
    await expect(evaluateNoCompletions(db)).resolves.toEqual({ tripped: false });

    await insertReviews([reviewValues({ status: 'running', completed_at: null })]);
    await expect(evaluateNoCompletions(db)).resolves.toEqual({
      tripped: true,
      details: { kind: 'no_completions', createdCount: 5 },
    });

    await insertReviews([reviewValues({ status: 'completed' })]);
    await expect(evaluateNoCompletions(db)).resolves.toEqual({ tripped: false });
  });

  it('detects error category spikes by terminal reason', async () => {
    await insertReviews(
      Array.from({ length: 5 }, () =>
        reviewValues({ status: 'failed', terminal_reason: 'timeout' })
      )
    );
    await expect(evaluateErrorCategorySpike(db)).resolves.toEqual({ tripped: false });

    await insertReviews([reviewValues({ status: 'failed', terminal_reason: 'upstream_error' })]);
    await expect(evaluateErrorCategorySpike(db)).resolves.toMatchObject({
      tripped: true,
      details: { kind: 'error_spike', reason: 'timeout', count: 5, total: 6 },
    });
  });

  it('counts cancelled interrupted reviews in error spikes', async () => {
    await insertReviews(
      Array.from({ length: 6 }, () =>
        reviewValues({ status: 'cancelled', terminal_reason: 'interrupted' })
      )
    );

    await expect(evaluateErrorCategorySpike(db)).resolves.toMatchObject({
      tripped: true,
      details: { kind: 'error_spike', reason: 'interrupted', count: 6, total: 6 },
    });
  });

  it('does not trip error category spikes below the share threshold', async () => {
    await insertReviews([
      ...Array.from({ length: 2 }, () =>
        reviewValues({ status: 'failed', terminal_reason: 'timeout' })
      ),
      ...Array.from({ length: 2 }, () =>
        reviewValues({ status: 'failed', terminal_reason: 'upstream_error' })
      ),
      ...Array.from({ length: 2 }, () =>
        reviewValues({ status: 'failed', terminal_reason: 'unknown' })
      ),
    ]);

    await expect(evaluateErrorCategorySpike(db)).resolves.toEqual({ tripped: false });
  });
});
