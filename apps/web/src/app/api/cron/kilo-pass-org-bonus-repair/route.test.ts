import { beforeEach, describe, expect, test } from '@jest/globals';

jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/kilo-pass-org/bonus-repair-cron', () => ({
  runOrganizationPassBonusRepairCron: jest.fn(),
}));
jest.mock('@/lib/utils.server', () => ({ sentryLogger: jest.fn(() => jest.fn()) }));

import { runOrganizationPassBonusRepairCron } from '@/lib/kilo-pass-org/bonus-repair-cron';
import { GET } from './route';

const mockRunOrganizationPassBonusRepairCron = jest.mocked(runOrganizationPassBonusRepairCron);

function request(authorization?: string) {
  return new Request('http://localhost/api/cron/kilo-pass-org-bonus-repair', {
    headers: authorization ? { authorization } : undefined,
  });
}

describe('GET /api/cron/kilo-pass-org-bonus-repair', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([undefined, 'Bearer wrong-secret'])(
    'rejects invalid authorization',
    async authorization => {
      const response = await GET(request(authorization));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
      expect(mockRunOrganizationPassBonusRepairCron).not.toHaveBeenCalled();
    }
  );

  test('runs the repair processor and returns its summary for valid authorization', async () => {
    const summary = { examined: 4, recordedMisses: 2 };
    mockRunOrganizationPassBonusRepairCron.mockResolvedValue(summary);

    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      summary,
      timestamp: expect.any(String),
    });
    expect(mockRunOrganizationPassBonusRepairCron).toHaveBeenCalledTimes(1);
  });
});
