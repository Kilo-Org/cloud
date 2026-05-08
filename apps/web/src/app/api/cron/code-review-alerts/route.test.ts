import { NextRequest } from 'next/server';

const mockCheckAndRecordAlert = jest.fn();

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
  SLACK_CODE_REVIEW_WEBHOOK_URL: 'https://hooks.slack.test/code-review',
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/code-reviews/alerting/dedup-client', () => ({
  checkAndRecordAlert: (...args: unknown[]) => mockCheckAndRecordAlert(...args),
}));

import { db, sql } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { cloud_agent_code_reviews, kilocode_users, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { GET } from './route';

const REPO = `test-org/code-review-alert-cron-${Date.now()}`;
type CodeReviewInsert = typeof cloud_agent_code_reviews.$inferInsert;

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function makeRequest(headers?: Record<string, string>) {
  return new NextRequest('http://localhost:3000/api/cron/code-review-alerts', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/code-review-alerts', () => {
  let testUser: User;
  let reviewSequence = 0;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  beforeEach(async () => {
    await db.delete(cloud_agent_code_reviews).where(sql`true`);
    mockCheckAndRecordAlert.mockReset();
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
  });

  afterEach(async () => {
    await db.delete(cloud_agent_code_reviews).where(sql`true`);
    fetchSpy.mockRestore();
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

  it('rejects unauthorized requests', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockCheckAndRecordAlert).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('consults dedup before sending Slack alerts', async () => {
    await db
      .insert(cloud_agent_code_reviews)
      .values([
        ...Array.from({ length: 3 }, () =>
          reviewValues({ status: 'failed', terminal_reason: 'timeout' })
        ),
        ...Array.from({ length: 5 }, () => reviewValues({ status: 'completed' })),
        ...Array.from({ length: 5 }, () =>
          reviewValues({ status: 'queued', created_at: minutesAgo(20), updated_at: minutesAgo(16) })
        ),
      ]);
    mockCheckAndRecordAlert
      .mockResolvedValueOnce({ suppressed: false })
      .mockResolvedValueOnce({ suppressed: true });

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    expect(mockCheckAndRecordAlert).toHaveBeenNthCalledWith(1, 'failure_rate', 'ticket');
    expect(mockCheckAndRecordAlert).toHaveBeenNthCalledWith(2, 'stuck_reviews', 'ticket');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [webhookUrl, init] = fetchSpy.mock.calls[0];
    expect(webhookUrl).toBe('https://hooks.slack.test/code-review');
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(String(init?.body));
    expect(body.blocks[0].text.text).toContain('Code Review Pipeline Health');
    expect(body.blocks[1].fields[0].text).toContain('High Failure Rate');

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      evaluated: 4,
      tripped: 2,
      sent: 1,
      suppressed: 1,
      slack: 'sent',
      errors: [],
      alerts: [
        { detector: 'failure_rate', alertKey: 'failure_rate', suppressed: false, slack: 'sent' },
        {
          detector: 'stuck_reviews',
          alertKey: 'stuck_reviews',
          suppressed: true,
          slack: 'suppressed',
        },
      ],
      timestamp: expect.any(String),
    });
  });
});
