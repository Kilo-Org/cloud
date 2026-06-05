// Env must be set BEFORE importing the module under test so its constants
// resolve to the test values. KILO_CHAT_INTERNAL_URL is the preferred
// server-only destination; NEXT_PUBLIC_KILO_CHAT_URL is the migration-safe
// fallback.
process.env.KILO_CHAT_INTERNAL_URL = 'https://chat.kiloapps.io';
process.env.NEXT_PUBLIC_KILO_CHAT_URL = 'https://chat.kiloapps.io';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

import { postMessageAsUser } from './kilo-chat-internal-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const VALID_PARAMS = {
  userId: 'user-123',
  sandboxId: 'sandbox-456',
  message: 'Hello from the install flow',
  source: 'install',
};

describe('postMessageAsUser (cloud → kilo-chat internal HTTP)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs to the internal route with the api key header and body', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({
        ok: true,
        conversationId: 'conv-1',
        messageId: 'msg-1',
        conversationCreated: false,
      })
    );

    const result = await postMessageAsUser(VALID_PARAMS);

    expect(result).toEqual({
      ok: true,
      conversationId: 'conv-1',
      messageId: 'msg-1',
      conversationCreated: false,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://chat.kiloapps.io/internal/v1/post-message-as-user');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-internal-api-key']).toBe('test-internal-secret');
    expect(headers['content-type']).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify(VALID_PARAMS));
    expect(init?.cache).toBe('no-store');
  });

  it('returns a typed error result on 400 invalid_request', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        jsonResponse({ ok: false, code: 'invalid_request', error: 'message empty' }, 400)
      );

    const result = await postMessageAsUser(VALID_PARAMS);

    expect(result).toEqual({
      ok: false,
      code: 'invalid_request',
      error: 'message empty',
    });
  });

  it('returns a typed error result on 404 no_conversation', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        jsonResponse({ ok: false, code: 'no_conversation', error: 'user has no conversation' }, 404)
      );

    const result = await postMessageAsUser(VALID_PARAMS);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_conversation');
  });

  it('returns forbidden when the middleware rejects (envelope-less 403)', async () => {
    // `internalApiMiddleware` short-circuits before the route handler when
    // the api-key header is missing/wrong, returning `{ error: 'Forbidden' }`
    // rather than the discriminated-union shape. Client maps that to a
    // typed `forbidden` result so callers don't need to know.
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ error: 'Forbidden' }, 403));

    const result = await postMessageAsUser(VALID_PARAMS);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden');
  });

  it('throws on a non-JSON response', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('plain text broken', { status: 502 }));

    await expect(postMessageAsUser(VALID_PARAMS)).rejects.toThrow(/non-JSON response/);
  });

  it('throws on an unexpected JSON shape (non-403)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ totally: 'unexpected' }, 500));

    await expect(postMessageAsUser(VALID_PARAMS)).rejects.toThrow(/unexpected payload/);
  });

  it('prefers KILO_CHAT_INTERNAL_URL over NEXT_PUBLIC_KILO_CHAT_URL', async () => {
    const savedInternal = process.env.KILO_CHAT_INTERNAL_URL;
    const savedPublic = process.env.NEXT_PUBLIC_KILO_CHAT_URL;
    // Point the public var somewhere off-allowlist: if it were used, the call
    // would be refused. The internal var must win and the fetch must go to it.
    process.env.KILO_CHAT_INTERNAL_URL = 'https://chat.kiloapps.io';
    process.env.NEXT_PUBLIC_KILO_CHAT_URL = 'https://evil.example.com';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({
        ok: true,
        conversationId: 'conv-1',
        messageId: 'msg-1',
        conversationCreated: false,
      })
    );
    try {
      await postMessageAsUser(VALID_PARAMS);
      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://chat.kiloapps.io/internal/v1/post-message-as-user');
    } finally {
      process.env.KILO_CHAT_INTERNAL_URL = savedInternal;
      process.env.NEXT_PUBLIC_KILO_CHAT_URL = savedPublic;
    }
  });

  it('falls back to NEXT_PUBLIC_KILO_CHAT_URL with a warning when the internal var is unset', async () => {
    const savedInternal = process.env.KILO_CHAT_INTERNAL_URL;
    delete process.env.KILO_CHAT_INTERNAL_URL;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({
        ok: true,
        conversationId: 'conv-1',
        messageId: 'msg-1',
        conversationCreated: false,
      })
    );
    try {
      await postMessageAsUser(VALID_PARAMS);
      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://chat.kiloapps.io/internal/v1/post-message-as-user');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/KILO_CHAT_INTERNAL_URL is not set/)
      );
    } finally {
      process.env.KILO_CHAT_INTERNAL_URL = savedInternal;
    }
  });

  it('throws when neither destination var is configured', async () => {
    const savedInternal = process.env.KILO_CHAT_INTERNAL_URL;
    const savedPublic = process.env.NEXT_PUBLIC_KILO_CHAT_URL;
    delete process.env.KILO_CHAT_INTERNAL_URL;
    delete process.env.NEXT_PUBLIC_KILO_CHAT_URL;
    try {
      await expect(postMessageAsUser(VALID_PARAMS)).rejects.toThrow(
        /Neither KILO_CHAT_INTERNAL_URL nor NEXT_PUBLIC_KILO_CHAT_URL is configured/
      );
    } finally {
      process.env.KILO_CHAT_INTERNAL_URL = savedInternal;
      process.env.NEXT_PUBLIC_KILO_CHAT_URL = savedPublic;
    }
  });

  it('refuses to send the key to an off-allowlist origin (never fetches)', async () => {
    const saved = process.env.KILO_CHAT_INTERNAL_URL;
    process.env.KILO_CHAT_INTERNAL_URL = 'https://evil.example.com';
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      await expect(postMessageAsUser(VALID_PARAMS)).rejects.toThrow(
        /not an allowed kilo-chat origin/
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      process.env.KILO_CHAT_INTERNAL_URL = saved;
    }
  });

  it('returns a typed internal error when the request times out', async () => {
    // Simulate AbortSignal.timeout firing by having fetch reject with a
    // TimeoutError-named exception (which is what the browser/node fetch
    // surface when AbortSignal.timeout aborts a request).
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    jest.spyOn(global, 'fetch').mockRejectedValue(timeoutErr);

    const result = await postMessageAsUser(VALID_PARAMS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('internal');
      expect(result.error).toMatch(/timed out/);
    }
  });

  it('returns a typed internal error on a generic network failure', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await postMessageAsUser(VALID_PARAMS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('internal');
      expect(result.error).toMatch(/network down|fetch failed/);
    }
  });
});
