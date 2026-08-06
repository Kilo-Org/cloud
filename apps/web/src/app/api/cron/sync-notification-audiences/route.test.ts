jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/notifications/notification-audience-cache', () => ({
  syncNotificationAudiencesToRedis: jest.fn(),
}));

import { syncNotificationAudiencesToRedis } from '@/lib/notifications/notification-audience-cache';
import { GET } from './route';

const mockedSync = jest.mocked(syncNotificationAudiencesToRedis);

function makeRequest(headers?: Record<string, string>) {
  return new Request('http://localhost:3000/api/cron/sync-notification-audiences', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/sync-notification-audiences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects requests without authorization header', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('rejects requests with wrong authorization header', async () => {
    const response = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }));

    expect(response.status).toBe(401);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('runs the sync and reports counts on success', async () => {
    mockedSync.mockResolvedValueOnce({
      byokProviders: { rowCount: 3, userCount: 2 },
      autoModels: { rowCount: 4, userCount: 3 },
    });

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.byokProviders).toEqual({ rowCount: 3, userCount: 2 });
    expect(body.autoModels).toEqual({ rowCount: 4, userCount: 3 });
    expect(body.timestamp).toEqual(expect.any(String));
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the sync fails', async () => {
    mockedSync.mockRejectedValueOnce(new Error('boom'));

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.success).toBe(false);
  });
});
