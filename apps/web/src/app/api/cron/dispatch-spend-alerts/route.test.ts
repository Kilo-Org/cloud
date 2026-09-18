import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/spend-alerts/sweep', () => ({
  createSpendAlertSweepStore: jest.fn(() => ({ loadScopeSnapshot: jest.fn() })),
  runSpendAlertSweep: jest.fn(),
}));
jest.mock('@/lib/spend-alerts/delivery', () => ({
  drainPendingSpendAlertDeliveries: jest.fn(),
  spendAlertDeliveryDeps: { sendEmail: jest.fn(), dispatchPush: jest.fn() },
}));
const mockSentryLog = jest.fn();
jest.mock('@/lib/utils.server', () => ({ sentryLogger: jest.fn(() => mockSentryLog) }));

import { runSpendAlertSweep } from '@/lib/spend-alerts/sweep';
import { drainPendingSpendAlertDeliveries } from '@/lib/spend-alerts/delivery';
import { GET, maxDuration } from './route';

const mockRunSpendAlertSweep = jest.mocked(runSpendAlertSweep);
const mockDrainPendingSpendAlertDeliveries = jest.mocked(drainPendingSpendAlertDeliveries);

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
    mockDrainPendingSpendAlertDeliveries.mockResolvedValue({
      claimed: 3,
      delivered: 3,
      failed: [],
    });
  });

  test('rejects invalid cron authorization', async () => {
    const response = await GET(request('wrong-secret'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockRunSpendAlertSweep).not.toHaveBeenCalled();
    expect(mockDrainPendingSpendAlertDeliveries).not.toHaveBeenCalled();
  });

  test('sweeps then drains with a bounded limit and reports the summary', async () => {
    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      partialFailure: false,
      summary: { scopesTouched: 2, alertsFired: 3, delivered: 3, failed: 0 },
    });
    expect(mockRunSpendAlertSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ store: expect.anything() }),
      expect.objectContaining({ now: expect.any(Date) })
    );
    expect(mockDrainPendingSpendAlertDeliveries).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { limit: 50 }
    );
    expect(mockRunSpendAlertSweep.mock.invocationCallOrder[0]).toBeLessThan(
      mockDrainPendingSpendAlertDeliveries.mock.invocationCallOrder[0]
    );
    expect(mockSentryLog).toHaveBeenCalledWith(
      'Spend alert sweep and delivery drain completed',
      expect.objectContaining({ scopesTouched: 2, alertsFired: 3, delivered: 3, failed: 0 })
    );
  });

  test('surfaces partialFailure when a delivery fails', async () => {
    mockDrainPendingSpendAlertDeliveries.mockResolvedValue({
      claimed: 3,
      delivered: 2,
      failed: [
        {
          deliveryId: '00000000-0000-4000-8000-000000000001',
          channel: 'email',
          error: 'spend_alert_email_delivery_failed',
        },
      ],
    });

    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      partialFailure: true,
      summary: { delivered: 2, failed: 1 },
    });
    expect(mockSentryLog).toHaveBeenCalledWith(
      'Spend alert delivery completed with partial failures',
      expect.objectContaining({ failedCount: 1 })
    );
  });

  test('exports a bounded function duration', () => {
    expect(maxDuration).toBe(300);
  });
});
