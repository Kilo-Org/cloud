jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => ({ outcome: 'succeeded', ...fields })),
  buildScheduledJobFailureEvent: jest.fn(() => ({ outcome: 'failed', exception_name: 'Error' })),
  emitScheduledJobEvent: jest.fn(),
}));

jest.mock('@/lib/device-auth/device-auth', () => ({ cleanupExpiredDeviceAuthRequests: jest.fn() }));
jest.mock('@/lib/auth/native-admission', () => ({ cleanupExpiredAdmissionChallenges: jest.fn() }));
jest.mock('@/lib/kiloclaw/access-codes', () => ({ cleanupExpiredAccessCodes: jest.fn() }));
jest.mock('@/lib/integrations/github/install-state', () => ({
  cleanupExpiredInstallStates: jest.fn(),
}));
jest.mock('@/lib/utils.server', () => ({ sentryLogger: jest.fn(() => jest.fn()) }));

import { cleanupExpiredDeviceAuthRequests } from '@/lib/device-auth/device-auth';
import { cleanupExpiredAdmissionChallenges } from '@/lib/auth/native-admission';
import { cleanupExpiredAccessCodes } from '@/lib/kiloclaw/access-codes';
import { cleanupExpiredInstallStates } from '@/lib/integrations/github/install-state';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);

describe('GET /api/cron/cleanup-device-auth', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits one success event with all cleanup counts', async () => {
    jest.mocked(cleanupExpiredDeviceAuthRequests).mockResolvedValue(2);
    jest.mocked(cleanupExpiredAdmissionChallenges).mockResolvedValue(1);
    jest.mocked(cleanupExpiredAccessCodes).mockResolvedValue(3);
    jest.mocked(cleanupExpiredInstallStates).mockResolvedValue(4);

    const response = await GET(
      new Request('http://localhost/api/cron/cleanup-device-auth', {
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'succeeded',
      deleted_device_auth_request_count: 2,
      deleted_admission_challenge_count: 1,
      deleted_access_code_count: 3,
      deleted_install_state_count: 4,
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
