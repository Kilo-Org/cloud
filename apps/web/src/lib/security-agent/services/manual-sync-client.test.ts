import { submitManualSecuritySync } from './manual-sync-client';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
  SECURITY_SYNC_WORKER_URL: 'https://security-sync.test',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('submitManualSecuritySync', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('submits actor and repository scope to the Worker and returns accepted correlation ids', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () =>
        Promise.resolve({
          success: true,
          accepted: true,
          runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          messageId: 'message-123',
        }),
    });

    await expect(
      submitManualSecuritySync({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123', email: 'owner@example.com', name: 'Owner Example' },
        repoFullName: 'kilo/repo',
      })
    ).resolves.toEqual({
      accepted: true,
      runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      messageId: 'message-123',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://security-sync.test/internal/manual-sync',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
      })
    );
    expect(JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      schemaVersion: 1,
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      actor: { id: 'user-123', email: 'owner@example.com', name: 'Owner Example' },
      repoFullName: 'kilo/repo',
    });
  });
});
