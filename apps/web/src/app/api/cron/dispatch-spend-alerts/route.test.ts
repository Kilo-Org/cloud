import { NextRequest } from 'next/server';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/spend-alerts/sweep', () => ({
  createSpendAlertSweepStore: jest.fn(() => ({ loadScopeSnapshot: jest.fn() })),
  runSpendAlertSweep: jest.fn(),
}));
const mockSentryLog = jest.fn();
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  sentryLogger: jest.fn(() => mockSentryLog),
}));

import { runSpendAlertSweep } from '@/lib/spend-alerts/sweep';
import { GET, maxDuration } from './route';

const mockRunSpendAlertSweep = jest.mocked(runSpendAlertSweep);

function request(secret: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/dispatch-spend-alerts', {
    headers: { authorization: `Bearer ${secret}` },
  });
}

describe('GET /api/cron/dispatch-spend-alerts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunSpendAlertSweep.mockResolvedValue({
      sweptScopes: 4,
      candidateScopes: 2,
      fired: 3,
      cleared: 1,
      deliveriesEnqueued: 3,
    });
  });

  test('rejects invalid cron authorization', async () => {
    const response = await GET(request('wrong-secret'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockRunSpendAlertSweep).not.toHaveBeenCalled();
  });

  test('sweeps and reports the scopesTouched and alertsFired summary', async () => {
    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: { scopesTouched: 2, alertsFired: 3 },
    });
    expect(mockRunSpendAlertSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ store: expect.anything() }),
      expect.objectContaining({ now: expect.any(Date) })
    );
    expect(mockSentryLog).toHaveBeenCalledWith(
      'Spend alert sweep completed',
      expect.objectContaining({ scopesTouched: 2, alertsFired: 3 })
    );
  });

  test('exports a bounded function duration', () => {
    expect(maxDuration).toBe(300);
  });
});
