import { submitManualAnalysisStart } from './manual-analysis-client';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
  SECURITY_AUTO_ANALYSIS_WORKER_URL: 'https://security-auto-analysis.test',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('submitManualAnalysisStart', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('submits a durable manual analysis command and returns queued state', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ success: true, accepted: true }),
    });

    await expect(
      submitManualAnalysisStart({
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actorUserId: 'user-123',
        requestedModels: { analysisModel: 'analysis/model' },
        retrySandboxOnly: true,
      })
    ).resolves.toEqual({ queued: true });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://security-auto-analysis.test/internal/manual-analysis-start',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          actorUserId: 'user-123',
          requestedModels: { analysisModel: 'analysis/model' },
          retrySandboxOnly: true,
        }),
      })
    );
  });
});
