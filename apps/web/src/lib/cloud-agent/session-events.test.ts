import { generateBoundedInternalServiceToken } from '@kilocode/web-shared/lib/tokens';
import { notifyCliSessionRenamed, queueWorkspaceUpdates } from './session-events';

const mockAfter = jest.fn();
jest.mock('next/server', () => ({ after: (callback: () => Promise<void>) => mockAfter(callback) }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  SESSION_INGEST_WORKER_URL: 'https://ingest.test.example.com',
}));

jest.mock('@kilocode/web-shared/lib/tokens', () => ({
  generateBoundedInternalServiceToken: jest.fn().mockReturnValue('mock-jwt-token'),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

const mockGenerateBoundedInternalServiceToken = jest.mocked(generateBoundedInternalServiceToken);

it('queues unique workspace events in bounded authenticated batches after the response', async () => {
  mockAfter.mockClear();
  mockFetch.mockReset().mockResolvedValue({ ok: true });
  const worktreeIds = Array.from({ length: 401 }, (_, index) => `worktree_${index}`);
  queueWorkspaceUpdates({ userId: 'oauth/synthetic-owner', organizationId: null }, [
    ...worktreeIds,
    ...worktreeIds,
  ]);
  expect(mockFetch).not.toHaveBeenCalled();
  const callback = mockAfter.mock.calls[0][0];
  await callback();
  const bodies = mockFetch.mock.calls.map(([url, options]) => {
    expect(url).toBe('https://ingest.test.example.com/api/workspaces/notify');
    expect(options.headers.Authorization).toBe('Bearer mock-jwt-token');
    return JSON.parse(options.body) as { organizationId: null; worktreeIds: string[] };
  });
  expect(bodies.map(body => body.worktreeIds.length)).toEqual([200, 200, 1]);
  expect(bodies.flatMap(body => body.worktreeIds)).toEqual(worktreeIds);
});

describe('notifyCliSessionRenamed', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGenerateBoundedInternalServiceToken.mockReset().mockReturnValue('mock-jwt-token');
  });

  it('returns delivered on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ delivered: true }),
    });

    const result = await notifyCliSessionRenamed({
      sessionId: 'ses_abc123',
      title: 'New title',
      userId: 'user_123',
    });

    expect(result).toEqual({ delivered: true });
  });

  it('POSTs to rename-notify with auth, title body, and timeout', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ delivered: false }),
    });

    await notifyCliSessionRenamed({
      sessionId: 'ses_abc123',
      title: 'Renamed session',
      userId: 'user_test_456',
    });

    expect(mockGenerateBoundedInternalServiceToken).toHaveBeenCalledWith('user_test_456', {
      audience: 'session-ingest',
      expiresIn: 60 * 60,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.test.example.com/api/session/ses_abc123/rename-notify',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer mock-jwt-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'Renamed session' }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('encodes session ID in URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ delivered: true }),
    });

    await notifyCliSessionRenamed({
      sessionId: 'ses_with spaces&special',
      title: 'T',
      userId: 'user_123',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.test.example.com/api/session/ses_with%20spaces%26special/rename-notify',
      expect.any(Object)
    );
  });

  it('throws on non-OK response without capturing (caller owns Sentry)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('something broke'),
    });

    await expect(
      notifyCliSessionRenamed({
        sessionId: 'ses_abc123',
        title: 'T',
        userId: 'user_123',
      })
    ).rejects.toThrow(
      'Session ingest rename-notify failed: 500 Internal Server Error - something broke'
    );
  });
});
