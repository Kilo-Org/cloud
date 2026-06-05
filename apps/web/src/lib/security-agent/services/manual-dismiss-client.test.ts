import { submitManualFindingDismissal } from './manual-dismiss-client';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
  SECURITY_SYNC_WORKER_URL: 'https://security-sync.test',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('submitManualFindingDismissal', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('submits dismissal actor context and returns accepted correlation ids', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () =>
        Promise.resolve({
          success: true,
          accepted: true,
          runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          messageId: 'dismiss-message-123',
        }),
    });

    await expect(
      submitManualFindingDismissal({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123', email: 'owner@example.com', name: 'Owner Example' },
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: 'installation-123',
        reason: 'not_used',
        comment: 'No production usage',
      })
    ).resolves.toEqual({
      accepted: true,
      runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      messageId: 'dismiss-message-123',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://security-sync.test/internal/dismiss-finding',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
      })
    );
  });
});
