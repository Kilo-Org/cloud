import { captureException } from '@sentry/nextjs';
import { generateInternalServiceToken } from '@/lib/tokens';
import type { SessionSnapshot } from './session-ingest-client';
import { fetchSessionSnapshot, fetchSessionMessages } from './session-ingest-client';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(
  messages: Array<{
    role: string;
    parts: Array<{ type: string; text?: string; id?: string }>;
  }>
): SessionSnapshot {
  return {
    info: {},
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

  it('returns parsed snapshot on 200 response', async () => {
    const snapshot = makeSnapshot([
      { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]);

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
// fetchSessionMessages (thin wrapper)
// ---------------------------------------------------------------------------

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
