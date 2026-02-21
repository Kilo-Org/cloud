import type { SharedSessionSnapshot } from './client';
import { extractLastAssistantMessage } from './client';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/config.server', () => ({
  SESSION_INGEST_WORKER_URL: 'https://ingest.test.example.com',
  NEXTAUTH_SECRET: 'test-secret-key',
}));

jest.mock('@/lib/tokens', () => ({
  JWT_TOKEN_VERSION: 3,
}));

// Must be set before importing fetchSessionExport (which reads the global)
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(
  messages: Array<{
    role: string;
    parts: Array<{ type: string; text?: string; id?: string }>;
  }>
): SharedSessionSnapshot {
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
// extractLastAssistantMessage
// ---------------------------------------------------------------------------

describe('extractLastAssistantMessage', () => {
  it('should return null for empty messages', () => {
    const snapshot = makeSnapshot([]);
    expect(extractLastAssistantMessage(snapshot)).toBeNull();
  });

  it('should return null when no assistant messages exist', () => {
    const snapshot = makeSnapshot([{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }]);
    expect(extractLastAssistantMessage(snapshot)).toBeNull();
  });

  it('should extract text from a single assistant message', () => {
    const snapshot = makeSnapshot([
      { role: 'user', parts: [{ type: 'text', text: 'analyze this' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'The analysis shows...' }] },
    ]);
    expect(extractLastAssistantMessage(snapshot)).toBe('The analysis shows...');
  });

  it('should return the last assistant message when multiple exist', () => {
    const snapshot = makeSnapshot([
      { role: 'user', parts: [{ type: 'text', text: 'first question' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', parts: [{ type: 'text', text: 'second question' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'second answer' }] },
    ]);
    expect(extractLastAssistantMessage(snapshot)).toBe('second answer');
  });

  it('should concatenate multiple text parts', () => {
    const snapshot = makeSnapshot([
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Part one. ' },
          { type: 'text', text: 'Part two.' },
        ],
      },
    ]);
    expect(extractLastAssistantMessage(snapshot)).toBe('Part one. Part two.');
  });

  it('should skip non-text parts (tool calls, step-finish, etc.)', () => {
    const snapshot = makeSnapshot([
      {
        role: 'assistant',
        parts: [
          { type: 'tool', text: undefined },
          { type: 'text', text: 'The result is clear.' },
          { type: 'step-finish' },
        ],
      },
    ]);
    expect(extractLastAssistantMessage(snapshot)).toBe('The result is clear.');
  });

  it('should skip assistant messages with empty text and return earlier one', () => {
    const snapshot = makeSnapshot([
      { role: 'assistant', parts: [{ type: 'text', text: 'Earlier answer with content.' }] },
      { role: 'user', parts: [{ type: 'text', text: 'followup' }] },
      { role: 'assistant', parts: [{ type: 'tool' }] }, // no text parts
    ]);
    expect(extractLastAssistantMessage(snapshot)).toBe('Earlier answer with content.');
  });

  it('should skip parts where text is not a string', () => {
    const snapshot: SharedSessionSnapshot = {
      info: {},
      messages: [
        {
          info: { id: 'msg_0', role: 'assistant' },
          parts: [
            { id: 'p1', type: 'text', text: undefined as unknown as string },
            { id: 'p2', type: 'text', text: 'valid text' },
          ],
        },
      ],
    };
    expect(extractLastAssistantMessage(snapshot)).toBe('valid text');
  });
});

// ---------------------------------------------------------------------------
// fetchSessionExport
// ---------------------------------------------------------------------------

describe('fetchSessionExport', () => {
  // Dynamic import to ensure mocks are set up first
  let fetchSessionExport: typeof import('./client').fetchSessionExport;

  beforeAll(async () => {
    const mod = await import('./client');
    fetchSessionExport = mod.fetchSessionExport;
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should return parsed snapshot on 200 response', async () => {
    const snapshot = makeSnapshot([
      { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(snapshot),
    });

    const result = await fetchSessionExport('ses_abc123', 'user_123');

    expect(result).toEqual(snapshot);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.test.example.com/api/session/ses_abc123/export',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer /),
        }),
      })
    );
  });

  it('should return null on 404 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const result = await fetchSessionExport('ses_nonexistent', 'user_123');
    expect(result).toBeNull();
  });

  it('should throw on 500 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('something broke'),
    });

    await expect(fetchSessionExport('ses_abc123', 'user_123')).rejects.toThrow(
      'Session ingest export failed: 500 Internal Server Error - something broke'
    );
  });

  it('should throw on 401 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('invalid token'),
    });

    await expect(fetchSessionExport('ses_abc123', 'user_123')).rejects.toThrow(
      'Session ingest export failed: 401 Unauthorized - invalid token'
    );
  });

  it('should encode session ID in URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSnapshot([])),
    });

    await fetchSessionExport('ses_with spaces&special', 'user_123');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.test.example.com/api/session/ses_with%20spaces%26special/export',
      expect.any(Object)
    );
  });

  it('should generate JWT with correct payload', async () => {
    const jwt = await import('jsonwebtoken');

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSnapshot([])),
    });

    await fetchSessionExport('ses_abc123', 'user_test_456');

    // Extract the token from the Authorization header
    const callArgs = mockFetch.mock.calls[0];
    const authHeader = callArgs[1].headers.Authorization as string;
    const token = authHeader.replace('Bearer ', '');

    // Verify the token payload
    const decoded = jwt.verify(token, 'test-secret-key') as Record<string, unknown>;
    expect(decoded.kiloUserId).toBe('user_test_456');
    expect(decoded.version).toBe(3);
  });
});
