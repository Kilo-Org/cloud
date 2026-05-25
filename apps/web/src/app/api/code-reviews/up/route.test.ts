import { NextRequest } from 'next/server';

const mockCaptureException = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { db, sql } from '@/lib/drizzle';
import { CODE_REVIEW_RUNBOOK_URL } from '@/lib/code-reviews/alerting/health-response';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { cloud_agent_code_reviews, kilocode_users, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { GET } from './route';

const REPO = `test-org/code-review-up-${Date.now()}`;
type CodeReviewInsert = typeof cloud_agent_code_reviews.$inferInsert;

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function makeRequest(key: string | null) {
  const url =
    key === null
      ? 'http://localhost:3000/api/code-reviews/up'
      : `http://localhost:3000/api/code-reviews/up?key=${key}`;
  return new NextRequest(url, { method: 'GET' });
}

describe('GET /api/code-reviews/up', () => {
  let testUser: User;
  let reviewSequence = 0;

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  beforeEach(async () => {
    await db.delete(cloud_agent_code_reviews).where(sql`true`);
    mockCaptureException.mockReset();
  });

  afterEach(async () => {
    await db.delete(cloud_agent_code_reviews).where(sql`true`);
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  function reviewValues(overrides: Partial<CodeReviewInsert> = {}) {
    const sequence = reviewSequence++;
    const startedAt = minutesAgo(10);
    const completedAt = minutesAgo(5);

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
      created_at: startedAt,
      updated_at: completedAt,
      started_at: startedAt,
      completed_at: completedAt,
      ...overrides,
    } satisfies CodeReviewInsert;
  }

  it('rejects requests with the wrong key', async () => {
    const response = await GET(makeRequest('wrong-key'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ healthy: false });
  });

  it('rejects requests with no key', async () => {
    const response = await GET(makeRequest(null));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ healthy: false });
  });

  it('returns healthy when no detectors trip', async () => {
    const response = await GET(makeRequest('kilo-code-reviews-health-check'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      healthy: true,
      alerts: [],
      metadata: {
        runbookUrl: CODE_REVIEW_RUNBOOK_URL,
        timestamp: expect.any(String),
      },
    });
  });

  it('runs each detector inside its own timed transaction', async () => {
    const txExecuteCalls: jest.Mock[] = [];
    const transactionSpy = jest.spyOn(db, 'transaction').mockImplementation(async callback => {
      const execute = jest.fn().mockResolvedValue({ rows: [] });
      txExecuteCalls.push(execute);
      return callback({ execute } as never);
    });

    try {
      const response = await GET(makeRequest('kilo-code-reviews-health-check'));

      expect(response.status).toBe(200);
      expect(transactionSpy).toHaveBeenCalledTimes(2);
      expect(txExecuteCalls).toHaveLength(2);
      for (const execute of txExecuteCalls) {
        expect(execute).toHaveBeenCalledTimes(2);
      }
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('returns 503 with slow-review alert when slow-review rate trips', async () => {
    await db.insert(cloud_agent_code_reviews).values([
      reviewValues({
        started_at: minutesAgo(71),
        created_at: minutesAgo(71),
        completed_at: minutesAgo(10),
      }),
      ...Array.from({ length: 9 }, () => reviewValues()),
    ]);

    const response = await GET(makeRequest('kilo-code-reviews-health-check'));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      healthy: false,
      alerts: [
        {
          kind: 'slow_reviews',
          label: 'Slow Reviews',
          severity: 'ticket',
          rate: 0.1,
          startedCount: 10,
          slowCount: 1,
          windowMinutes: 120,
          durationMinutes: 60,
          adminUrl: expect.stringContaining('/admin/code-reviews'),
          runbookUrl: CODE_REVIEW_RUNBOOK_URL,
        },
      ],
    });
  });

  it('returns 503 with error-spike alert when error rate trips', async () => {
    await db
      .insert(cloud_agent_code_reviews)
      .values([
        reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
        reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
        reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
        reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
        ...Array.from({ length: 16 }, () => reviewValues()),
      ]);

    const response = await GET(makeRequest('kilo-code-reviews-health-check'));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      healthy: false,
      alerts: [
        {
          kind: 'error_spike',
          label: 'Error Spike',
          severity: 'ticket',
          rate: 0.2,
          startedCount: 20,
          errorCount: 4,
          windowMinutes: 30,
          topReason: 'timeout',
          topReasonCount: 4,
          adminUrl: expect.stringContaining('/admin/code-reviews'),
          runbookUrl: CODE_REVIEW_RUNBOOK_URL,
        },
      ],
    });
  });

  it('returns healthy when model-not-found rows reach the error-spike threshold', async () => {
    await db.insert(cloud_agent_code_reviews).values([
      reviewValues({ status: 'cancelled', terminal_reason: 'model_not_found' }),
      reviewValues({
        status: 'failed',
        terminal_reason: null,
        error_message: 'Model not found: kilo/retired-model',
      }),
      reviewValues({ status: 'cancelled', terminal_reason: 'model_not_found' }),
      reviewValues({
        status: 'failed',
        terminal_reason: null,
        error_message: 'Model not found: kilo/another-retired-model',
      }),
      ...Array.from({ length: 16 }, () => reviewValues()),
    ]);

    const response = await GET(makeRequest('kilo-code-reviews-health-check'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ healthy: true, alerts: [] });
  });

  it('still returns an error-spike alert for non-model not-found failures', async () => {
    await db
      .insert(cloud_agent_code_reviews)
      .values([
        reviewValues({ status: 'failed', error_message: 'Repository not found' }),
        reviewValues({ status: 'failed', error_message: 'Session not found' }),
        reviewValues({ status: 'failed', error_message: 'Checkout failed' }),
        reviewValues({ status: 'failed', error_message: 'GitHub unavailable' }),
        ...Array.from({ length: 16 }, () => reviewValues()),
      ]);

    const response = await GET(makeRequest('kilo-code-reviews-health-check'));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      healthy: false,
      alerts: [expect.objectContaining({ kind: 'error_spike', errorCount: 4, rate: 0.2 })],
    });
  });

  it('ignores stale queued rows for health', async () => {
    await db.insert(cloud_agent_code_reviews).values(
      Array.from({ length: 20 }, () =>
        reviewValues({
          status: 'queued',
          created_at: minutesAgo(60),
          updated_at: minutesAgo(60),
          started_at: null,
          completed_at: null,
        })
      )
    );

    const response = await GET(makeRequest('kilo-code-reviews-health-check'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ healthy: true, alerts: [] });
  });

  it('returns multiple alerts when multiple detectors trip', async () => {
    await db.insert(cloud_agent_code_reviews).values([
      ...Array.from({ length: 3 }, () =>
        reviewValues({
          started_at: minutesAgo(71),
          created_at: minutesAgo(71),
          completed_at: minutesAgo(10),
        })
      ),
      reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
      reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
      reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
      reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
      reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
      ...Array.from({ length: 17 }, () => reviewValues()),
    ]);

    const response = await GET(makeRequest('kilo-code-reviews-health-check'));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.healthy).toBe(false);
    const kinds = body.alerts.map((alert: { kind: string }) => alert.kind);
    expect(kinds).toEqual(expect.arrayContaining(['slow_reviews', 'error_spike']));
  });

  it('fails open and captures every detector error to Sentry when the database is unreachable', async () => {
    const transactionSpy = jest
      .spyOn(db, 'transaction')
      .mockRejectedValue(new Error('DB unavailable'));

    try {
      const response = await GET(makeRequest('kilo-code-reviews-health-check'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ healthy: true, alerts: [] });
      expect(mockCaptureException).toHaveBeenCalledTimes(2);
      const detectorTags = mockCaptureException.mock.calls
        .map(call => call[1].tags.detector)
        .sort();
      expect(detectorTags).toEqual(['error_spike', 'slow_reviews']);
      expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
        tags: { endpoint: 'code-reviews/up', source: 'code_review_health_check' },
      });
    } finally {
      transactionSpy.mockRestore();
    }
  });
});
