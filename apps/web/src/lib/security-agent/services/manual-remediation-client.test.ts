import { submitManualRemediationStart } from './manual-remediation-client';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
  SECURITY_AUTO_ANALYSIS_WORKER_URL: 'https://security-auto-analysis.test',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('submitManualRemediationStart', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns queued attempt correlation for accepted admission', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () =>
        Promise.resolve({
          success: true,
          accepted: true,
          admitted: true,
          remediationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          attemptNumber: 1,
        }),
    });

    await expect(
      submitManualRemediationStart({
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owner: { userId: 'user-123' },
        actorUserId: 'user-123',
      })
    ).resolves.toEqual({
      queued: true,
      remediationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      attemptNumber: 1,
    });
  });

  it('returns a typed policy rejection for analysis_required', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({
          success: false,
          accepted: false,
          admitted: false,
          reason: 'analysis_required',
        }),
    });

    await expect(
      submitManualRemediationStart({
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owner: { userId: 'user-123' },
        actorUserId: 'user-123',
      })
    ).resolves.toEqual({ queued: false, reason: 'analysis_required' });
  });

  it('returns a typed not-found rejection when the finding disappears', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: () =>
        Promise.resolve({
          success: false,
          accepted: false,
          admitted: false,
          reason: 'finding_not_found',
        }),
    });

    await expect(
      submitManualRemediationStart({
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owner: { userId: 'user-123' },
        actorUserId: 'user-123',
      })
    ).resolves.toEqual({ queued: false, reason: 'finding_not_found' });
  });
});
