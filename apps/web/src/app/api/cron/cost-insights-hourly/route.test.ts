import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/cost-insights/jobs', () => ({ runCostInsightHourlySweep: jest.fn() }));
const mockSentryLog = jest.fn();
jest.mock('@/lib/utils.server', () => ({ sentryLogger: jest.fn(() => mockSentryLog) }));

import { runCostInsightHourlySweep } from '@/lib/cost-insights/jobs';
import { GET, maxDuration } from './route';

const mockRunCostInsightHourlySweep = jest.mocked(runCostInsightHourlySweep);

function summary(failedOwners: Array<{ owner: { type: 'user'; id: string }; error: string }> = []) {
  return {
    evaluatedOwners: 2,
    failedOwners,
    dirtyEvaluations: {
      claimed: 1,
      evaluatedOwners: [{ type: 'user' as const, id: 'user-1' }],
      failedOwners: [],
    },
    notifications: {
      claimed: 1,
      sent: 1,
      skipped: 0,
      terminalized: 0,
      failed: 0,
    },
    alreadyRunning: false,
    deadlineReached: false,
    ownerCycleComplete: true,
    cycleId: 'cycle-1',
  };
}

describe('GET /api/cron/cost-insights-hourly', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns failure status and telemetry for a partial owner failure', async () => {
    mockRunCostInsightHourlySweep.mockResolvedValue(
      summary([{ owner: { type: 'user', id: 'user-2' }, error: 'evaluation failed' }])
    );

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/cost-insights-hourly', {
        headers: { authorization: 'Bearer cron-secret' },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ success: false, partialFailure: true });
    expect(mockSentryLog).toHaveBeenCalledWith(
      'Cost Insights hourly sweep completed with partial failures',
      expect.objectContaining({ failedOwnerCount: 1 })
    );
  });

  test('returns success only when all work succeeds', async () => {
    mockRunCostInsightHourlySweep.mockResolvedValue(summary());

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/cost-insights-hourly', {
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      partialFailure: false,
    });
    expect(mockSentryLog).not.toHaveBeenCalled();
  });

  test('exports a bounded function duration for resumable sweeps', () => {
    expect(maxDuration).toBe(300);
  });
});
