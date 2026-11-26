import { NextRequest } from 'next/server';
import type * as configModule from '@kilocode/web-shared/lib/config.server';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<typeof configModule>('@kilocode/web-shared/lib/config.server'),
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => ({ outcome: 'succeeded', ...fields })),
  buildScheduledJobFailureEvent: jest.fn((_run, error) => ({
    outcome: 'failed',
    exception_name: error instanceof Error ? error.name : 'UnknownError',
  })),
  emitScheduledJobEvent: jest.fn(),
}));

import { eq } from 'drizzle-orm';
import { user_sign_in_contexts } from '@kilocode/db/schema';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { recordSignInContext } from '@/lib/auth/sign-in-context';
import { GET, maxDuration } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);
const DAY = 24 * 60 * 60 * 1_000;

function makeRequest(headers?: Record<string, string>) {
  return new NextRequest('http://localhost:3000/api/cron/prune-sign-in-contexts', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/prune-sign-in-contexts', () => {
  // The prune is table-wide: start each case from an empty database.
  beforeEach(async () => {
    jest.clearAllMocks();
    await cleanupDbForTest();
  });
  afterEach(cleanupDbForTest);

  it('exports maxDuration of 300 seconds', () => {
    expect(maxDuration).toBe(300);
  });

  it('rejects requests without the cron secret', async () => {
    expect((await GET(makeRequest())).status).toBe(401);
    expect((await GET(makeRequest({ authorization: 'Bearer wrong-secret' }))).status).toBe(401);
    expect(mockEmitScheduledJobEvent).not.toHaveBeenCalled();
  });

  it('deletes contexts older than 90 days and keeps recent ones and the history marker', async () => {
    const user = await insertTestUser();
    await recordSignInContext({
      userId: user.id,
      device: { kind: 'browser_cookie', secret: 'laptop' },
      network: 'DE 203.0.0.0/16',
      now: new Date(Date.now() - 91 * DAY),
    });
    await recordSignInContext({
      userId: user.id,
      device: { kind: 'browser_cookie', secret: 'phone' },
      network: 'DE 203.0.0.0/16',
      now: new Date(Date.now() - 89 * DAY),
    });

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ expiredDeleted: 1, otherKeyDeleted: 0, hasMore: false });
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded', deleted_count: 1, has_more: false })
    );
    const remaining = await db
      .select({ kind: user_sign_in_contexts.kind })
      .from(user_sign_in_contexts)
      .where(eq(user_sign_in_contexts.user_id, user.id));
    // The laptop is gone; the network was refreshed by the phone sign-in.
    expect(remaining.map(row => row.kind).sort()).toEqual(['device', 'history', 'network']);
  });
});
