import { NextRequest } from 'next/server';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/byok/backfill-envelopes', () => ({ backfillByokEnvelopes: jest.fn() }));

import { backfillByokEnvelopes } from '@/lib/byok/backfill-envelopes';
import { GET, maxDuration } from './route';

const mockBackfill = jest.mocked(backfillByokEnvelopes);

const summary = {
  enabled: true,
  scanned: 3,
  migrated: 3,
  skippedConcurrentWrite: 0,
  failed: 0,
  remaining: 0,
  drained: true,
};

function request(secret: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/backfill-byok-envelopes', {
    headers: { authorization: `Bearer ${secret}` },
  });
}

describe('GET /api/cron/backfill-byok-envelopes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockBackfill.mockResolvedValue(summary);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('rejects invalid cron authorization', async () => {
    const response = await GET(request('wrong-secret'));

    expect(response.status).toBe(401);
    expect(mockBackfill).not.toHaveBeenCalled();
  });

  test('runs the backfill inside the function duration and returns its summary', async () => {
    const before = Date.now();
    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(summary);
    const { deadlineAt } = mockBackfill.mock.calls[0][0];
    expect(deadlineAt - before).toBeLessThan(maxDuration * 1000);
    expect(deadlineAt - before).toBeGreaterThan(0);
  });

  test('logs the counts of a successful tick', async () => {
    await GET(request('cron-secret'));

    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('"job_name":"web.backfill_byok_envelopes"')
    );
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"migrated_count":3'));
  });

  test('logs how many rows still lack an envelope, so completion is visible', async () => {
    await GET(request('cron-secret'));
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"remaining_count":0'));
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"drained":true'));

    jest.mocked(console.info).mockClear();
    mockBackfill.mockResolvedValue({ ...summary, migrated: 1, remaining: 7, drained: false });
    await GET(request('cron-secret'));
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"remaining_count":7'));
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"drained":false'));
  });

  test('fails the tick when a row could not be migrated', async () => {
    mockBackfill.mockResolvedValue({ ...summary, migrated: 2, failed: 1 });

    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ failed: 1, migrated: 2 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"outcome":"failed"'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"failed_count":1'));
  });

  test('logs and rethrows an unexpected error', async () => {
    mockBackfill.mockRejectedValue(new Error('db down'));

    await expect(GET(request('cron-secret'))).rejects.toThrow('db down');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"outcome":"failed"'));
  });

  test('exports a bounded function duration', () => {
    expect(maxDuration).toBe(300);
  });
});
