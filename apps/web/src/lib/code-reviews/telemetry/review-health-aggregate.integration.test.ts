import { db } from '@/lib/drizzle';
import {
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  type User,
} from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';

import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  REVIEW_COLLECTION_METRIC,
  REVIEW_OPEN_METRIC,
  REVIEW_OUTCOME_METRIC,
  REVIEW_PUBLICATION_METRIC,
  REVIEW_REASON_METRIC,
  REVIEW_START_METRIC,
  collectCodeReviewOpenStock,
  collectCodeReviewOutcome,
} from './review-health-aggregate';
import { resetCodeReviewForRetry, updateCodeReviewStatus } from '../db/code-reviews';

const REPO = `test-org/review-health-${Date.now()}`;
const PII_MARKER = 'pii-marker-must-not-be-logged';

describe('review health aggregate against the database', () => {
  let user: User;
  const createdReviewIds: string[] = [];
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeAll(async () => {
    user = await insertTestUser();
  });

  afterAll(async () => {
    if (createdReviewIds.length > 0) {
      await db
        .delete(cloud_agent_code_review_attempts)
        .where(inArray(cloud_agent_code_review_attempts.code_review_id, createdReviewIds));
      await db
        .delete(cloud_agent_code_reviews)
        .where(inArray(cloud_agent_code_reviews.id, createdReviewIds));
    }
  });

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  async function insertReview(input: {
    status: string;
    createdAt: string;
    updatedAt?: string;
    startedAt?: string | null;
    completedAt?: string | null;
    terminalReason?: string | null;
    sessionId?: string | null;
  }): Promise<string> {
    const [row] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_user_id: user.id,
        repo_full_name: REPO,
        pr_number: Math.floor(Math.random() * 1_000_000_000),
        pr_url: 'https://github.com/test-org/review-health/pull/1',
        pr_title: 'Review health fixture',
        pr_author: 'test-author',
        base_ref: 'main',
        head_ref: 'feature',
        head_sha: 'b'.repeat(40),
        platform: 'github',
        status: input.status,
        terminal_reason: input.terminalReason ?? null,
        session_id: input.sessionId ?? PII_MARKER,
        error_message: PII_MARKER,
        created_at: input.createdAt,
        updated_at: input.updatedAt ?? input.createdAt,
        started_at: input.startedAt ?? null,
        completed_at: input.completedAt ?? null,
      })
      .returning({ id: cloud_agent_code_reviews.id });
    createdReviewIds.push(row.id);
    return row.id;
  }

  async function insertAttempt(input: {
    reviewId: string;
    attemptNumber: number;
    publicationStatus?: string | null;
    status?: string;
  }): Promise<void> {
    await db.insert(cloud_agent_code_review_attempts).values({
      code_review_id: input.reviewId,
      attempt_number: input.attemptNumber,
      status: input.status ?? 'completed',
      publication_status: input.publicationStatus ?? null,
    });
  }

  function loggedRecords(): Record<string, unknown>[] {
    return logSpy.mock.calls.map(([line]) => JSON.parse(line as string));
  }

  function outcomeRecords(): Record<string, unknown>[] {
    return loggedRecords().filter(record => record.metric === REVIEW_OUTCOME_METRIC);
  }

  function reasonRecords(): Record<string, unknown>[] {
    return loggedRecords().filter(record => record.metric === REVIEW_REASON_METRIC);
  }

  it('counts one review with two attempts as one unit and never joins attempts', async () => {
    const now = new Date('2096-04-01T00:12:00.000Z');
    const reviewId = await insertReview({
      status: 'completed',
      createdAt: '2096-04-01T00:00:00.000Z',
      startedAt: '2096-04-01T00:05:00.000Z',
      completedAt: '2096-04-01T00:09:00.000Z',
    });
    await db.insert(cloud_agent_code_review_attempts).values([
      { code_review_id: reviewId, attempt_number: 1, status: 'failed' },
      { code_review_id: reviewId, attempt_number: 2, status: 'completed' },
    ]);

    await collectCodeReviewOutcome(now);

    const outcome = outcomeRecords()[0];
    expect(outcome).toMatchObject({
      completed: 1,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
      windowStart: '2096-04-01T00:05:00.000Z',
      windowEnd: '2096-04-01T00:10:00.000Z',
    });
    const start = loggedRecords().find(record => record.metric === REVIEW_START_METRIC);
    expect(start).toMatchObject({ started: 1, startedWithinFiveMinutes: 1 });
    expect(reasonRecords()).toEqual([]);

    const serialized = logSpy.mock.calls.map(([line]) => line).join('\n');
    expect(serialized).not.toContain(reviewId);
    expect(serialized).not.toContain(PII_MARKER);
    expect(serialized).not.toContain(REPO);
    expect(serialized).not.toContain('review-health/pull');
    expect(serialized).not.toContain('b'.repeat(40));
  });

  it('treats provider_unavailable as unrecognized without logging the raw string', async () => {
    await insertReview({
      status: 'failed',
      createdAt: '2096-04-02T00:00:00.000Z',
      completedAt: '2096-04-02T00:06:00.000Z',
      terminalReason: 'provider_unavailable',
      sessionId: null,
    });

    await collectCodeReviewOutcome(new Date('2096-04-02T00:12:00.000Z'));

    const outcome = outcomeRecords()[0];
    expect(outcome).toMatchObject({ failed: 1, completed: 0 });
    expect(reasonRecords()).toEqual([
      expect.objectContaining({ reason: 'unrecognized', reasonClass: 'unknown', count: 1 }),
    ]);

    const serialized = logSpy.mock.calls.map(([line]) => line).join('\n');
    expect(serialized).not.toContain('provider_unavailable');
  });

  it('keeps reason rows consistent with each emitted headline when a review is retried', async () => {
    const pendingId = await insertReview({
      status: 'pending',
      createdAt: '2096-04-03T00:00:00.000Z',
      sessionId: null,
    });
    await updateCodeReviewStatus(pendingId, 'failed', {
      terminalReason: 'sandbox_error',
      completedAt: new Date('2096-04-03T00:04:00.000Z'),
    });

    await collectCodeReviewOutcome(new Date('2096-04-03T00:07:00.000Z'));
    const firstOutcome = outcomeRecords().find(
      record => record.observedAt === '2096-04-03T00:07:00.000Z'
    );
    expect(firstOutcome).toMatchObject({
      failed: 1,
      completed: 0,
      windowStart: '2096-04-03T00:00:00.000Z',
      windowEnd: '2096-04-03T00:05:00.000Z',
    });
    const firstReason = reasonRecords().find(
      record => record.observedAt === '2096-04-03T00:07:00.000Z'
    );
    expect(firstReason).toMatchObject({ reason: 'sandbox_error', count: 1 });

    expect(await resetCodeReviewForRetry(pendingId)).toBe(1);
    await collectCodeReviewOutcome(new Date('2096-04-03T00:08:00.000Z'));
    const secondOutcome = outcomeRecords().find(
      record => record.observedAt === '2096-04-03T00:08:00.000Z'
    );
    expect(secondOutcome).toMatchObject({
      failed: 0,
      completed: 0,
      windowStart: '2096-04-03T00:00:00.000Z',
      windowEnd: '2096-04-03T00:05:00.000Z',
    });
    expect(
      reasonRecords().filter(record => record.observedAt === '2096-04-03T00:08:00.000Z')
    ).toEqual([]);

    const latestObservedAt = secondOutcome?.observedAt as string;
    const latestReasonCount = reasonRecords()
      .filter(record => record.observedAt === latestObservedAt)
      .reduce((sum, record) => sum + (record.count as number), 0);
    expect(latestReasonCount).toBe(0);
    expect(
      reasonRecords().some(
        record =>
          record.observedAt === '2096-04-03T00:07:00.000Z' && record.reason === 'sandbox_error'
      )
    ).toBe(true);

    await updateCodeReviewStatus(pendingId, 'completed', {
      completedAt: new Date('2096-04-03T00:14:00.000Z'),
    });
    await collectCodeReviewOutcome(new Date('2096-04-03T00:17:00.000Z'));
    const completedRecords = outcomeRecords().filter(record => record.completed === 1);
    expect(completedRecords).toHaveLength(1);
    expect(completedRecords[0]).toMatchObject({
      windowStart: '2096-04-03T00:10:00.000Z',
      windowEnd: '2096-04-03T00:15:00.000Z',
      observedAt: '2096-04-03T00:17:00.000Z',
    });
  });

  it('keeps stored failed and cancelled model_not_found as one benign reason row', async () => {
    await insertReview({
      status: 'failed',
      createdAt: '2096-04-04T00:00:00.000Z',
      completedAt: '2096-04-04T00:06:00.000Z',
      terminalReason: 'model_not_found',
    });
    await insertReview({
      status: 'cancelled',
      createdAt: '2096-04-04T00:00:00.000Z',
      completedAt: '2096-04-04T00:06:00.000Z',
      terminalReason: 'model_not_found',
    });

    await collectCodeReviewOutcome(new Date('2096-04-04T00:12:00.000Z'));

    const outcome = outcomeRecords()[0];
    expect(outcome).toMatchObject({ failed: 1, cancelled: 1, completed: 0 });
    expect(reasonRecords()).toEqual([
      expect.objectContaining({
        observedAt: '2096-04-04T00:12:00.000Z',
        windowStart: '2096-04-04T00:05:00.000Z',
        windowEnd: '2096-04-04T00:10:00.000Z',
        reason: 'model_not_found',
        reasonClass: 'benign',
        count: 2,
      }),
    ]);
  });

  it('reports one missing and three unknown publications across the latest attempt of each completed review', async () => {
    const completedAt = '2096-05-01T00:06:00.000Z';
    const reviewBase = { status: 'completed', createdAt: '2096-05-01T00:00:00.000Z', completedAt };

    const bothMissing = await insertReview(reviewBase);
    await insertAttempt({ reviewId: bothMissing, attemptNumber: 1, publicationStatus: 'missing' });
    await insertAttempt({ reviewId: bothMissing, attemptNumber: 2, publicationStatus: 'missing' });

    await insertReview(reviewBase);

    const latestNullEarlierMissing = await insertReview(reviewBase);
    await insertAttempt({
      reviewId: latestNullEarlierMissing,
      attemptNumber: 1,
      publicationStatus: 'missing',
    });
    await insertAttempt({
      reviewId: latestNullEarlierMissing,
      attemptNumber: 2,
      publicationStatus: null,
    });

    const unknownStatus = await insertReview(reviewBase);
    await insertAttempt({
      reviewId: unknownStatus,
      attemptNumber: 1,
      publicationStatus: 'unknown',
    });

    const latestPublished = await insertReview(reviewBase);
    await insertAttempt({
      reviewId: latestPublished,
      attemptNumber: 1,
      publicationStatus: 'missing',
    });
    await insertAttempt({
      reviewId: latestPublished,
      attemptNumber: 2,
      publicationStatus: 'published',
    });

    for (const publicationStatus of ['unchanged', 'not_applicable', 'published']) {
      const reviewId = await insertReview(reviewBase);
      await insertAttempt({ reviewId, attemptNumber: 1, publicationStatus });
    }

    const failed = await insertReview({ ...reviewBase, status: 'failed' });
    await insertAttempt({ reviewId: failed, attemptNumber: 1, publicationStatus: 'missing' });

    const outside = await insertReview({
      status: 'completed',
      createdAt: '2096-04-30T23:50:00.000Z',
      completedAt: '2096-05-01T00:03:00.000Z',
    });
    await insertAttempt({ reviewId: outside, attemptNumber: 1, publicationStatus: 'missing' });

    await collectCodeReviewOutcome(new Date('2096-05-01T00:12:00.000Z'));

    const publication = loggedRecords().find(
      record =>
        record.metric === REVIEW_PUBLICATION_METRIC &&
        record.observedAt === '2096-05-01T00:12:00.000Z'
    );
    expect(publication).toEqual({
      metric: REVIEW_PUBLICATION_METRIC,
      environment: process.env.VERCEL_ENV ?? null,
      observedAt: '2096-05-01T00:12:00.000Z',
      windowStart: '2096-05-01T00:05:00.000Z',
      windowEnd: '2096-05-01T00:10:00.000Z',
      missingPublication: 1,
      coverageUnknown: 3,
    });

    const serialized = logSpy.mock.calls.map(([line]) => line).join('\n');
    expect(serialized).not.toContain(bothMissing);
    expect(serialized).not.toContain(PII_MARKER);
  });

  it('emits zero publication findings for a window with no completed reviews', async () => {
    await collectCodeReviewOutcome(new Date('2096-05-02T00:12:00.000Z'));

    const publication = loggedRecords().find(
      record =>
        record.metric === REVIEW_PUBLICATION_METRIC &&
        record.observedAt === '2096-05-02T00:12:00.000Z'
    );
    expect(publication).toMatchObject({ missingPublication: 0, coverageUnknown: 0 });
  });

  it('keeps a null completed_at out of the outcome window and increments missingCompletedAt', async () => {
    const collectionTimestamp = new Date('2096-04-06T00:10:00.000Z');

    logSpy.mockClear();
    await collectCodeReviewOpenStock(collectionTimestamp);
    const before = loggedRecords().find(record => record.metric === REVIEW_OPEN_METRIC);
    const beforeCount = before?.missingCompletedAt as number;

    await insertReview({
      status: 'failed',
      createdAt: '1996-04-06T00:00:00.000Z',
      updatedAt: '1996-04-06T00:00:00.000Z',
      completedAt: null,
      terminalReason: 'provider_unavailable',
    });

    logSpy.mockClear();
    await collectCodeReviewOutcome(collectionTimestamp);
    const outcome = outcomeRecords()[0];
    expect(outcome).toMatchObject({ completed: 0, failed: 0, cancelled: 0, interrupted: 0 });

    logSpy.mockClear();
    await collectCodeReviewOpenStock(collectionTimestamp);
    const snapshot = loggedRecords().find(record => record.metric === REVIEW_OPEN_METRIC);
    expect(snapshot?.missingCompletedAt).toBe(beforeCount + 1);
  });

  it('logs three collection rows and no counts when the select always throws', async () => {
    const failingDb = {
      select: () => {
        throw new Error('injected review query failure');
      },
    };
    await collectCodeReviewOutcome(new Date('2096-04-07T00:10:00.000Z'), failingDb as never);

    expect(errorSpy).toHaveBeenCalledTimes(3);
    const records = errorSpy.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(records).toEqual([
      expect.objectContaining({
        metric: REVIEW_COLLECTION_METRIC,
        collector: REVIEW_OUTCOME_METRIC,
      }),
      expect.objectContaining({ metric: REVIEW_COLLECTION_METRIC, collector: REVIEW_START_METRIC }),
      expect.objectContaining({
        metric: REVIEW_COLLECTION_METRIC,
        collector: REVIEW_PUBLICATION_METRIC,
      }),
    ]);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
