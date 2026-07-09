jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/notifications/byok-provider-cache', () => ({
  syncByokProviderNotificationsToRedis: jest.fn(),
}));

import { syncByokProviderNotificationsToRedis } from '@/lib/notifications/byok-provider-cache';
import { GET } from './route';

const mockedSync = jest.mocked(syncByokProviderNotificationsToRedis);

function makeRequest(headers?: Record<string, string>) {
  return new Request('http://localhost:3000/api/cron/sync-byok-provider-notifications', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/sync-byok-provider-notifications', () => {
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
    mockedSync.mockResolvedValueOnce({ rowCount: 3, userCount: 2 });

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.rowCount).toBe(3);
    expect(body.userCount).toBe(2);
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
