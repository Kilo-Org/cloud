import { captureException } from '@sentry/nextjs';
import { generateInternalServiceToken } from '@/lib/tokens';
import type { SessionSnapshot } from './session-ingest-client';
import {
  fetchSessionSnapshot,
  fetchSessionMessages,
  fetchSessionMessagesPage,
  deleteSession,
  shareSession,
  invalidateOrganizationSessionAccess,
} from './session-ingest-client';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/config.server', () => ({
  SESSION_INGEST_WORKER_URL: 'https://ingest.test.example.com',
  INTERNAL_API_SECRET: 'internal-secret',
}));

jest.mock('@/lib/tokens', () => ({
  generateInternalServiceToken: jest.fn().mockReturnValue('mock-jwt-token'),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

const mockCaptureException = jest.mocked(captureException);
const mockGenerateInternalServiceToken = jest.mocked(generateInternalServiceToken);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(
  messages: Array<{
    role: string;
    parts: Array<{ type: string; text?: string; id?: string }>;
  }>,
  info: SessionSnapshot['info'] = {}
): SessionSnapshot {
  return {
    info,
    messages: messages.map((m, i) => ({
      info: { id: `msg_${i}`, role: m.role },
      parts: m.parts.map((p, j) => ({
        id: p.id ?? `part_${i}_${j}`,
        type: p.type,
        ...(p.text !== undefined ? { text: p.text } : {}),
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// fetchSessionSnapshot
// ---------------------------------------------------------------------------

describe('fetchSessionSnapshot', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockCaptureException.mockReset();
    mockGenerateInternalServiceToken.mockReset().mockReturnValue('mock-jwt-token');
  });

  it('returns parsed snapshot with session model metadata on 200 response', async () => {
    const snapshot = makeSnapshot(
      [{ role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }],
      {
        id: 'ses_abc123',
        title: 'Remote session',
        model: {
          providerID: 'anthropic',
          id: 'claude-sonnet-4',
          variant: 'thinking',
        },
      }
    );

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(snapshot),
    });

    const result = await fetchSessionSnapshot('ses_abc123', 'user_123');

    expect(result).toEqual(snapshot);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.test.example.com/api/session/ses_abc123/export',
      expect.objectContaining({
        headers: { Authorization: 'Bearer mock-jwt-token' },
      })
    );
  });

  it('validates session model metadata', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          info: {
            id: 'ses_abc123',
            model: { providerID: 'anthropic', id: 42, variant: 'thinking' },
          },
          messages: [],
        }),
    });

    await expect(fetchSessionSnapshot('ses_abc123', 'user_123')).rejects.toThrow();
  });

  it('returns null on 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

    const result = await fetchSessionSnapshot('ses_nonexistent', 'user_123');
    expect(result).toBeNull();
  });

  it('throws and reports to Sentry on 500', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('something broke'),
    });

    await expect(fetchSessionSnapshot('ses_abc123', 'user_123')).rejects.toThrow(
      'Session ingest export failed: 500 Internal Server Error - something broke'
    );

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { source: 'session-ingest-client', endpoint: 'export' },
        extra: { sessionId: 'ses_abc123', status: 500 },
      })
    );
  });

  it('throws on 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('invalid token'),
    });

    await expect(fetchSessionSnapshot('ses_abc123', 'user_123')).rejects.toThrow(
      'Session ingest export failed: 401 Unauthorized - invalid token'
    );
  });

  it('encodes session ID in URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSnapshot([])),
    });

    await fetchSessionSnapshot('ses_with spaces&special', 'user_123');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.test.example.com/api/session/ses_with%20spaces%26special/export',
      expect.any(Object)
    );
  });

  it('generates token for the given userId', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSnapshot([])),
    });

    await fetchSessionSnapshot('ses_abc123', 'user_test_456');

    expect(mockGenerateInternalServiceToken).toHaveBeenCalledWith('user_test_456');
  });

  it('uses the generated token in the Authorization header', async () => {
    mockGenerateInternalServiceToken.mockReturnValue('custom-test-token');

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSnapshot([])),
    });

    await fetchSessionSnapshot('ses_abc123', 'user_123');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: 'Bearer custom-test-token' },
      })
    );
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe('deleteSession', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockCaptureException.mockReset();
    mockGenerateInternalServiceToken.mockReset().mockReturnValue('mock-jwt-token');
  });

  it('resolves successfully on 200', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await expect(deleteSession('ses_abc123', 'user_123')).resolves.toBeUndefined();
  });

  it('calls DELETE on the correct URL', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await deleteSession('ses_abc123', 'user_123');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.test.example.com/api/session/ses_abc123',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('sends correct Authorization header', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await deleteSession('ses_abc123', 'user_123');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { Authorization: 'Bearer mock-jwt-token' } })
    );
  });

  it('generates token for the given userId', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await deleteSession('ses_abc123', 'user_test_456');

    expect(mockGenerateInternalServiceToken).toHaveBeenCalledWith('user_test_456');
  });

  it('throws and calls captureException on 500', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('something broke'),
    });

    await expect(deleteSession('ses_abc123', 'user_123')).rejects.toThrow(
      'Session ingest delete failed: 500 Internal Server Error - something broke'
    );

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { source: 'session-ingest-client', endpoint: 'delete' },
        extra: { sessionId: 'ses_abc123', status: 500 },
      })
    );
  });

  it('resolves successfully on 404 (idempotent delete)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve(''),
    });

    await expect(deleteSession('ses_nonexistent', 'user_123')).resolves.toBeUndefined();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('encodes session ID in URL', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await deleteSession('ses_with spaces&special', 'user_123');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.test.example.com/api/session/ses_with%20spaces%26special',
      expect.any(Object)
    );
  });
});

// ---------------------------------------------------------------------------
// shareSession
// ---------------------------------------------------------------------------

describe('shareSession', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockCaptureException.mockReset();
    mockGenerateInternalServiceToken.mockReset().mockReturnValue('mock-jwt-token');
  });

  it('returns public_id on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, public_id: 'pub_abc123' }),
    });

    const result = await shareSession('ses_abc123', 'user_123');

    expect(result).toEqual({ public_id: 'pub_abc123' });
  });

  it('calls POST on the correct URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, public_id: 'pub_abc123' }),
    });

    await shareSession('ses_abc123', 'user_123');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.test.example.com/api/session/ses_abc123/share',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sends correct Authorization header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, public_id: 'pub_abc123' }),
    });

    await shareSession('ses_abc123', 'user_123');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { Authorization: 'Bearer mock-jwt-token' } })
    );
  });

  it('generates token for the given userId', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, public_id: 'pub_abc123' }),
    });

    await shareSession('ses_abc123', 'user_test_456');

    expect(mockGenerateInternalServiceToken).toHaveBeenCalledWith('user_test_456');
  });

  it('throws on 404', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(shareSession('ses_nonexistent', 'user_123')).rejects.toThrow('Session not found');
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('throws and calls captureException on 500', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('something broke'),
    });

    await expect(shareSession('ses_abc123', 'user_123')).rejects.toThrow(
      'Session ingest share failed: 500 Internal Server Error - something broke'
    );

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { source: 'session-ingest-client', endpoint: 'share' },
        extra: { sessionId: 'ses_abc123', status: 500 },
      })
    );
  });

  it('encodes session ID in URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, public_id: 'pub_abc123' }),
    });

    await shareSession('ses_with spaces&special', 'user_123');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.test.example.com/api/session/ses_with%20spaces%26special/share',
      expect.any(Object)
    );
  });
});

// ---------------------------------------------------------------------------
// fetchSessionMessages (thin wrapper)
// ---------------------------------------------------------------------------

describe('invalidateOrganizationSessionAccess', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockCaptureException.mockReset();
  });

  it('reports and throws invalidation failures', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: () => Promise.resolve('cache unavailable'),
    });

    await expect(
      invalidateOrganizationSessionAccess('usr_removed', '11111111-1111-4111-8111-111111111111')
    ).rejects.toThrow(
      'Session access invalidation failed: 503 Service Unavailable - cache unavailable'
    );
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { source: 'session-ingest-client', endpoint: 'invalidate-session-access' },
        extra: {
          kiloUserId: 'usr_removed',
          organizationId: '11111111-1111-4111-8111-111111111111',
          status: 503,
        },
      })
    );
  });

  it('calls the secret-protected organization invalidation endpoint', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204 });

    await invalidateOrganizationSessionAccess(
      'usr_removed',
      '11111111-1111-4111-8111-111111111111'
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.test.example.com/internal/session-access/invalidate',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Internal-Secret': 'internal-secret',
        },
        body: JSON.stringify({
          kiloUserId: 'usr_removed',
          organizationId: '11111111-1111-4111-8111-111111111111',
        }),
        signal: expect.any(AbortSignal),
      }
    );
  });

  it('sets a 30-second invalidation deadline', async () => {
    const signal = new AbortController().signal;
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    mockFetch.mockResolvedValue({ ok: true, status: 204 });

    await invalidateOrganizationSessionAccess(
      'usr_removed',
      '11111111-1111-4111-8111-111111111111'
    );

    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.test.example.com/internal/session-access/invalidate',
      expect.objectContaining({ signal })
    );
    timeout.mockRestore();
  });
});

describe('fetchSessionMessages', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGenerateInternalServiceToken.mockReset().mockReturnValue('mock-jwt-token');
  });

  const fakeUser = { id: 'user_123' } as Parameters<typeof fetchSessionMessages>[1];

  it('returns messages array from snapshot', async () => {
    const snapshot = makeSnapshot([
      { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(snapshot),
    });

    const result = await fetchSessionMessages('ses_abc123', fakeUser);
    expect(result).toEqual(snapshot.messages);
  });

  it('returns null on 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

    const result = await fetchSessionMessages('ses_abc123', fakeUser);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchSessionMessagesPage (paginated authorized history)
// ---------------------------------------------------------------------------

describe('fetchSessionMessagesPage', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGenerateInternalServiceToken.mockReset().mockReturnValue('mock-jwt-token');
  });

  const validSessionId = 'ses_12345678901234567890123456';
  const storedMessage = {
    info: {
      id: 'msg_user_01',
      sessionID: validSessionId,
      role: 'user',
      time: { created: 1761000000100 },
      agent: 'build',
      model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
    },
    parts: [
      {
        id: 'prt_user_01',
        sessionID: validSessionId,
        messageID: 'msg_user_01',
        type: 'text',
        text: 'hello',
      },
    ],
  };

  it('returns the bounded page and the opaque next cursor', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          success: true,
          kiloSessionId: validSessionId,
          history: {
            messages: [storedMessage],
            nextCursor: 'opaque-cursor',
            omittedItemCount: 0,
          },
        }),
    });

    const result = await fetchSessionMessagesPage(validSessionId, 'user_123', {
      limit: 50,
    });
    expect(result).toEqual({
      kiloSessionId: validSessionId,
      history: {
        messages: [storedMessage],
        nextCursor: 'opaque-cursor',
        omittedItemCount: 0,
      },
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      `https://ingest.test.example.com/api/session/${validSessionId}/messages?limit=50`
    );
    expect(init.headers.Authorization).toBe('Bearer mock-jwt-token');
  });

  it('forwards a continuation cursor in the query string', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          success: true,
          kiloSessionId: validSessionId,
          history: { messages: [], nextCursor: null, omittedItemCount: 0 },
        }),
    });

    await fetchSessionMessagesPage(validSessionId, 'user_123', {
      limit: 25,
      before: 'opaque-cursor',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      `https://ingest.test.example.com/api/session/${validSessionId}/messages?limit=25&before=opaque-cursor`
    );
  });

  it('preserves retryable_failure, too_large, and invalid_data outcomes from the worker', async () => {
    for (const history of [
      { kind: 'retryable_failure', phase: 'page_parts' },
      { kind: 'too_large', maximumBytes: 8 * 1024 * 1024, phase: 'message_scan' },
      { kind: 'invalid_data' },
    ]) {
      mockFetch.mockReset();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, kiloSessionId: validSessionId, history }),
      });
      const result = await fetchSessionMessagesPage(validSessionId, 'user_123', { limit: 10 });
      expect(result).toEqual({ kiloSessionId: validSessionId, history });
    }
  });

  it('returns null history for an empty page and treats missing history as null', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          success: true,
          kiloSessionId: validSessionId,
          history: null,
        }),
    });
    await expect(
      fetchSessionMessagesPage(validSessionId, 'user_123', { limit: 50 })
    ).resolves.toEqual({ kiloSessionId: validSessionId, history: null });
  });

  it('returns null when the worker reports session_not_found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: () => Promise.resolve({ success: false, error: 'session_not_found' }),
    });

    await expect(
      fetchSessionMessagesPage(validSessionId, 'user_123', { limit: 50 })
    ).resolves.toBeNull();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('throws and calls captureException on non-404 worker errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('boom'),
    });

    await expect(
      fetchSessionMessagesPage(validSessionId, 'user_123', { limit: 50 })
    ).rejects.toThrow(/Session ingest messages page failed/);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { source: 'session-ingest-client', endpoint: 'messagesPage' },
      })
    );
  });

  it('encodes the session ID and uses the configured worker URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          success: true,
          kiloSessionId: validSessionId,
          history: { messages: [], nextCursor: null, omittedItemCount: 0 },
        }),
    });

    await fetchSessionMessagesPage('ses_with spaces', 'user_123', { limit: 50 });
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://ingest.test.example.com/api/session/ses_with%20spaces/messages?limit=50'
    );
  });
});
