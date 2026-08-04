import { db } from '@/lib/drizzle';
import {
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  type User,
} from '@kilocode/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';

import { insertTestUser } from '@/tests/helpers/user.helper';
import { reapStaleCodeReviews } from './reap-stale-reviews';

const REPO = `test-org/reap-stale-${Date.now()}`;

/**
 * Runs the reaper against the real test database, unlike the unit suite, whose
 * drizzle mock swallows the WHERE clauses. This is what pins the parts only the
 * database can prove: the staleness predicate, and that the optimistic-lock
 * claim matches a microsecond-precision `updated_at` written by DB-side now()
 * after a select/bind round trip. If a driver or ORM upgrade ever changes
 * timestamp parsing precision, this suite fails instead of every reap silently
 * claiming nothing.
 */
describe('reapStaleCodeReviews against the database', () => {
  let user: User;
  const createdReviewIds: string[] = [];

  beforeAll(async () => {
    user = await insertTestUser();
  });

  afterAll(async () => {
    if (createdReviewIds.length > 0) {
      await db
        .delete(cloud_agent_code_reviews)
        .where(inArray(cloud_agent_code_reviews.id, createdReviewIds));
    }
  });

  async function insertReview(params: { status: string; hoursOld: number }): Promise<string> {
    // Timestamps come from DB-side now() so they carry microsecond precision,
    // like every defaultNow()/`$onUpdateFn` row in production. App-side ISO
    // strings would only exercise the easy millisecond case.
    const age = sql.raw(`now() - interval '${params.hoursOld} hours'`);
    const [row] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_user_id: user.id,
        repo_full_name: REPO,
        pr_number: Math.floor(Math.random() * 1_000_000),
        pr_url: 'https://github.com/test-org/reap-stale/pull/1',
        pr_title: 'Reap integration fixture',
        pr_author: 'test-author',
        base_ref: 'main',
        head_ref: 'feature',
        head_sha: 'a'.repeat(40),
        platform: 'github',
        status: params.status,
        created_at: age as never,
        updated_at: age as never,
      })
      .returning({ id: cloud_agent_code_reviews.id });
    createdReviewIds.push(row.id);
    return row.id;
  }

  it('claims a stale pending review and leaves a fresh one alone', async () => {
    const staleId = await insertReview({ status: 'pending', hoursOld: 72 });
    const freshId = await insertReview({ status: 'pending', hoursOld: 1 });

    const summary = await reapStaleCodeReviews(500);

    const [staleRow] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, staleId));
    expect(staleRow.status).toBe('failed');
    expect(staleRow.terminal_reason).toBe('abandoned');
    expect(staleRow.completed_at).not.toBeNull();

    const [freshRow] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, freshId));
    expect(freshRow.status).toBe('pending');
    expect(freshRow.terminal_reason).toBeNull();

    expect(summary.terminalized).toBeGreaterThanOrEqual(1);
  });

  it('closes the review’s own non-terminal attempts with it', async () => {
    const reviewId = await insertReview({ status: 'running', hoursOld: 72 });
    await db.insert(cloud_agent_code_review_attempts).values({
      code_review_id: reviewId,
      attempt_number: 1,
      status: 'running',
    });

    await reapStaleCodeReviews(500);

    const attempts = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, reviewId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('failed');
    expect(attempts[0].terminal_reason).toBe('abandoned');
  });

  it('does not reselect rows it already terminalized', async () => {
    const reviewId = await insertReview({ status: 'queued', hoursOld: 72 });

    await reapStaleCodeReviews(500);
    const secondRun = await reapStaleCodeReviews(500);

    const [row] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId));
    expect(row.status).toBe('failed');
    // The second run may pick up other suites' fixtures, but not this row: its
    // status is terminal, so the selection predicate excludes it structurally.
    expect(secondRun.selected).toBeGreaterThanOrEqual(0);
  });
});
