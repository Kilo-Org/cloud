jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => ({ outcome: 'succeeded', ...fields })),
  buildScheduledJobFailureEvent: jest.fn(() => ({ outcome: 'failed', exception_name: 'Error' })),
  emitScheduledJobEvent: jest.fn(),
}));

jest.mock('@/lib/device-auth/device-auth', () => ({ cleanupExpiredDeviceAuthRequests: jest.fn() }));
jest.mock('@/lib/kiloclaw/access-codes', () => ({ cleanupExpiredAccessCodes: jest.fn() }));
jest.mock('@/lib/utils.server', () => ({ sentryLogger: jest.fn(() => jest.fn()) }));

import { cleanupExpiredDeviceAuthRequests } from '@/lib/device-auth/device-auth';
import { cleanupExpiredAccessCodes } from '@/lib/kiloclaw/access-codes';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);

describe('GET /api/cron/cleanup-device-auth', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits one success event with both cleanup counts', async () => {
    jest.mocked(cleanupExpiredDeviceAuthRequests).mockResolvedValue(2);
    jest.mocked(cleanupExpiredAccessCodes).mockResolvedValue(3);

    const response = await GET(
      new Request('http://localhost/api/cron/cleanup-device-auth', {
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'succeeded',
      deleted_device_auth_request_count: 2,
      deleted_access_code_count: 3,
    });
  });

  it('emits one failure event then rethrows a cleanup error', async () => {
    jest.mocked(cleanupExpiredDeviceAuthRequests).mockRejectedValue(new Error('cleanup failed'));

    await expect(
      GET(
        new Request('http://localhost/api/cron/cleanup-device-auth', {
          headers: { authorization: 'Bearer cron-secret' },
        })
      )
    ).rejects.toThrow('cleanup failed');
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'failed',
      exception_name: 'Error',
    });
  });
});
