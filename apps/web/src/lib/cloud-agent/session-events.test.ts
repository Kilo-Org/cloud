import { captureException } from '@sentry/nextjs';
import { generateInternalServiceToken } from '@/lib/tokens';
import { notifyCliSessionRenamed } from './session-events';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/config.server', () => ({
  SESSION_INGEST_WORKER_URL: 'https://ingest.test.example.com',
}));

jest.mock('@/lib/tokens', () => ({
  generateInternalServiceToken: jest.fn().mockReturnValue('mock-jwt-token'),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

const mockCaptureException = jest.mocked(captureException);
const mockGenerateInternalServiceToken = jest.mocked(generateInternalServiceToken);

describe('notifyCliSessionRenamed', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockCaptureException.mockReset();
    mockGenerateInternalServiceToken.mockReset().mockReturnValue('mock-jwt-token');
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

    expect(mockGenerateInternalServiceToken).toHaveBeenCalledWith('user_test_456');
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

  it('throws and calls captureException on non-OK response', async () => {
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

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { source: 'session-events', endpoint: 'rename-notify' },
        extra: { sessionId: 'ses_abc123', status: 500 },
      })
    );
  });
});
