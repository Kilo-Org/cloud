import { beforeEach, describe, expect, test } from '@jest/globals';

jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/drizzle', () => ({ db: {} }));
jest.mock('@/lib/kilo-pass-org/service', () => ({ runOrganizationPassIssuanceCron: jest.fn() }));
jest.mock('@/lib/kilo-pass-org/notifications', () => ({
  dispatchOrganizationPassBlockedNotifications: jest.fn(),
}));
jest.mock('@/lib/utils.server', () => ({ sentryLogger: jest.fn(() => jest.fn()) }));

import { db } from '@/lib/drizzle';
import { dispatchOrganizationPassBlockedNotifications } from '@/lib/kilo-pass-org/notifications';
import { runOrganizationPassIssuanceCron } from '@/lib/kilo-pass-org/service';
import { GET } from './route';

const mockRunOrganizationPassIssuanceCron = jest.mocked(runOrganizationPassIssuanceCron);
const mockDispatchNotifications = jest.mocked(dispatchOrganizationPassBlockedNotifications);

function request(authorization?: string) {
  return new Request('http://localhost/api/cron/kilo-pass-org-issuance', {
    headers: authorization ? { authorization } : undefined,
  });
}

describe('GET /api/cron/kilo-pass-org-issuance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([undefined, 'Bearer wrong-secret'])(
    'rejects invalid authorization',
    async authorization => {
      const response = await GET(request(authorization));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
      expect(mockRunOrganizationPassIssuanceCron).not.toHaveBeenCalled();
    }
  );

  test('runs the issuance processor and returns its summary for valid authorization', async () => {
    const summary = {
      examined: 4,
      processed: 3,
      issued: 2,
      blocked: 1,
      failed: 0,
      failures: [],
    };
    const notifications = { examined: 1, sent: 1, failed: 0 };
    mockRunOrganizationPassIssuanceCron.mockResolvedValue(summary);
    mockDispatchNotifications.mockResolvedValue(notifications);

    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      summary,
      notifications,
      timestamp: expect.any(String),
    });
    expect(mockRunOrganizationPassIssuanceCron).toHaveBeenCalledTimes(1);
    expect(mockRunOrganizationPassIssuanceCron.mock.calls[0]?.[0]).toBe(db);
  });

  test('reports issuance failures before notification dispatch and returns a failure status', async () => {
    const summary = {
      examined: 1,
      processed: 0,
      issued: 0,
      blocked: 0,
      failed: 1,
      failures: [{ agreementId: 'agreement-1', message: 'issuance failed' }],
    };
    mockRunOrganizationPassIssuanceCron.mockResolvedValue(summary);
    mockDispatchNotifications.mockRejectedValue(new Error('mail unavailable'));

    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      summary,
      error: 'Notification dispatch failed',
    });
  });
});
