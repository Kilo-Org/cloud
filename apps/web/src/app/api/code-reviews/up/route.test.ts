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
      expect(transactionSpy).toHaveBeenCalledTimes(4);
      expect(txExecuteCalls).toHaveLength(4);
      for (const execute of txExecuteCalls) {
        expect(execute).toHaveBeenCalledTimes(2);
      }
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('returns 503 with failure-rate alert when failure rate trips', async () => {
    await db
      .insert(cloud_agent_code_reviews)
      .values([
        ...Array.from({ length: 4 }, () =>
          reviewValues({ status: 'failed', terminal_reason: 'timeout' })
        ),
        ...Array.from({ length: 11 }, () => reviewValues({ status: 'completed' })),
      ]);

    const response = await GET(makeRequest('kilo-code-reviews-health-check'));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      healthy: false,
      alerts: [
        {
          kind: 'failure_rate',
          label: 'High Failure Rate',
          severity: 'ticket',
          rate: expect.any(Number),
          total: 15,
          failures: 4,
          topReason: 'timeout',
          topReasonCount: 4,
          adminUrl: expect.stringContaining('/admin/code-reviews'),
          runbookUrl: CODE_REVIEW_RUNBOOK_URL,
        },
      ],
    });
  });

  it('returns 503 with stuck-reviews alert when reviews are stuck', async () => {
    await db.insert(cloud_agent_code_reviews).values([
      ...Array.from({ length: 5 }, () =>
        reviewValues({ status: 'queued', created_at: minutesAgo(20), updated_at: minutesAgo(16) })
      ),
      // Avoid also tripping no_completions: keep at least one completed review.
      reviewValues({ status: 'completed' }),
    ]);

    const response = await GET(makeRequest('kilo-code-reviews-health-check'));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      healthy: false,
      alerts: [
        {
          kind: 'stuck_reviews',
          label: 'Stuck Reviews',
          severity: 'ticket',
          queuedCount: 5,
          runningCount: 0,
        },
      ],
    });
  });

  it('returns multiple alerts when multiple detectors trip', async () => {
    await db
      .insert(cloud_agent_code_reviews)
      .values([
        ...Array.from({ length: 4 }, () =>
          reviewValues({ status: 'failed', terminal_reason: 'timeout' })
        ),
        ...Array.from({ length: 11 }, () => reviewValues({ status: 'completed' })),
        ...Array.from({ length: 5 }, () =>
          reviewValues({ status: 'queued', created_at: minutesAgo(20), updated_at: minutesAgo(16) })
        ),
      ]);

    const response = await GET(makeRequest('kilo-code-reviews-health-check'));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.healthy).toBe(false);
    const kinds = body.alerts.map((alert: { kind: string }) => alert.kind);
    expect(kinds).toEqual(expect.arrayContaining(['failure_rate', 'stuck_reviews']));
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
      expect(mockCaptureException).toHaveBeenCalledTimes(4);
      const detectorTags = mockCaptureException.mock.calls
        .map(call => call[1].tags.detector)
        .sort();
      expect(detectorTags).toEqual([
        'error_spike',
        'failure_rate',
        'no_completions',
        'stuck_reviews',
      ]);
      expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
        tags: { endpoint: 'code-reviews/up', source: 'code_review_health_check' },
      });
    } finally {
      transactionSpy.mockRestore();
    }
  });
});
