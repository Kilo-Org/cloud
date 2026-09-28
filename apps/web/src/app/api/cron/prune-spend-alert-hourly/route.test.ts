import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/spend-alerts/retention', () => ({
  pruneSpendAlertHourly: jest.fn(),
  SPEND_ALERT_HOURLY_RETENTION_DAYS: 30,
}));
const mockSentryLog = jest.fn();
jest.mock('@/lib/utils.server', () => ({ sentryLogger: jest.fn(() => mockSentryLog) }));

import { pruneSpendAlertHourly } from '@/lib/spend-alerts/retention';
import { GET, maxDuration } from './route';

const mockPruneSpendAlertHourly = jest.mocked(pruneSpendAlertHourly);

function request(secret: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/prune-spend-alert-hourly', {
    headers: { authorization: `Bearer ${secret}` },
  });
}

describe('GET /api/cron/prune-spend-alert-hourly', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPruneSpendAlertHourly.mockResolvedValue({ deleted: 12 });
  });

  test('rejects invalid cron authorization', async () => {
    const response = await GET(request('wrong-secret'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockPruneSpendAlertHourly).not.toHaveBeenCalled();
  });

  test('prunes with the 30-day window and reports the deleted count', async () => {
    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: { deleted: 12, retentionDays: 30 },
    });
    expect(mockPruneSpendAlertHourly).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ now: expect.any(Date) })
    );
    expect(mockSentryLog).toHaveBeenCalledWith(
      'Spend alert hourly retention prune completed',
      expect.objectContaining({ deleted: 12, retentionDays: 30 })
    );
  });

  test('exports a bounded function duration', () => {
    expect(maxDuration).toBe(300);
  });
});
