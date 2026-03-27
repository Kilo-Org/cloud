import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createServerToken,
  createUserToken,
  createShortLivedUserToken,
  upsertStreamChatUsers,
  getOrCreateStreamChatChannel,
  deactivateStreamChatUsers,
  reactivateStreamChatUsers,
  setupDefaultStreamChatChannel,
} from './client';

// Decode a JWT payload without verifying signature (for test assertions only).
function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('createServerToken', () => {
  it('produces a JWT with server: true in the payload', async () => {
    const token = await createServerToken('test-secret');
    expect(token.split('.')).toHaveLength(3);
    const payload = decodeJwtPayload(token);
    expect(payload.server).toBe(true);
  });

  it('produces different tokens for different secrets', async () => {
    const t1 = await createServerToken('secret-a');
    const t2 = await createServerToken('secret-b');
    expect(t1).not.toBe(t2);
  });
});

describe('createUserToken', () => {
  it('produces a JWT with user_id in the payload', async () => {
    const token = await createUserToken('test-secret', 'user-123');
    const payload = decodeJwtPayload(token);
    expect(payload.user_id).toBe('user-123');
  });

  it('produces different tokens for different user IDs', async () => {
    const t1 = await createUserToken('secret', 'user-a');
    const t2 = await createUserToken('secret', 'user-b');
    expect(t1).not.toBe(t2);
  });
});

describe('createShortLivedUserToken', () => {
  it('produces a JWT with user_id, iat, and exp in the payload', async () => {
    const token = await createShortLivedUserToken('test-secret', 'user-456');
    const payload = decodeJwtPayload(token);
    expect(payload.user_id).toBe('user-456');
    expect(payload.iat).toEqual(expect.any(Number));
    expect(payload.exp).toEqual(expect.any(Number));
  });

  it('sets exp roughly 6 hours after iat', async () => {
    const token = await createShortLivedUserToken('test-secret', 'user-ttl');
    const payload = decodeJwtPayload(token);
    const iat = payload.iat as number;
    const exp = payload.exp as number;
    const sixHoursInSeconds = 6 * 60 * 60;
    // Allow 5 seconds of tolerance for test execution time
    expect(exp - iat).toBeGreaterThanOrEqual(sixHoursInSeconds - 5);
    expect(exp - iat).toBeLessThanOrEqual(sixHoursInSeconds + 5);
  });

  it('produces different tokens for different user IDs', async () => {
    const t1 = await createShortLivedUserToken('secret', 'user-a');
    const t2 = await createShortLivedUserToken('secret', 'user-b');
    expect(t1).not.toBe(t2);
  });
});

describe('upsertStreamChatUsers', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it('sends a POST to /users with correct headers and body', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    await upsertStreamChatUsers('my-api-key', 'server-jwt', [
      { id: 'user-1', name: 'User One' },
      { id: 'bot-1', name: 'Bot One', role: 'admin' },
    ]);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe('https://chat.stream-io-api.com/users?api_key=my-api-key');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Stream-Auth-Type']).toBe('jwt');
    expect(opts.headers['Authorization']).toBe('server-jwt');
    const body = JSON.parse(opts.body as string) as { users: Record<string, unknown> };
    expect(body.users['user-1']).toMatchObject({ id: 'user-1', name: 'User One' });
    expect(body.users['bot-1']).toMatchObject({ id: 'bot-1', name: 'Bot One', role: 'admin' });
  });

  it('throws on HTTP error with status and body in the message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Unauthorized',
    });

    await expect(upsertStreamChatUsers('key', 'jwt', [{ id: 'x', name: 'X' }])).rejects.toThrow(
      '403'
    );
  });
});

describe('getOrCreateStreamChatChannel', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it('POSTs to /channels/{type}/{id}/query with correct payload', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    await getOrCreateStreamChatChannel('my-key', 'server-jwt', 'messaging', 'chan-123', {
      created_by_id: 'user-1',
      members: ['user-1', 'bot-1'],
      name: 'Test Channel',
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe(
      'https://chat.stream-io-api.com/channels/messaging/chan-123/query?api_key=my-key'
    );
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string) as { data: unknown };
    expect(body.data).toMatchObject({
      created_by_id: 'user-1',
      members: ['user-1', 'bot-1'],
      name: 'Test Channel',
    });
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    });

    await expect(
      getOrCreateStreamChatChannel('key', 'jwt', 'messaging', 'chan-1', {
        created_by_id: 'u',
        members: ['u', 'b'],
      })
    ).rejects.toThrow('429');
  });
});

describe('deactivateStreamChatUsers', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it('POSTs to /api/v2/users/{id}/deactivate for each user', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await deactivateStreamChatUsers('my-key', 'my-secret', ['user-1', 'bot-user-1']);

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [url1, opts1] = mockFetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url1).toBe(
      'https://chat.stream-io-api.com/api/v2/users/user-1/deactivate?api_key=my-key'
    );
    expect(opts1.method).toBe('POST');
    expect(opts1.headers['Stream-Auth-Type']).toBe('jwt');

    const [url2] = mockFetch.mock.calls[1] as [string, unknown];
    expect(url2).toBe(
      'https://chat.stream-io-api.com/api/v2/users/bot-user-1/deactivate?api_key=my-key'
    );
  });

  it('silently ignores 404 responses', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => 'Not Found' });

    await expect(
      deactivateStreamChatUsers('key', 'secret', ['nonexistent'])
    ).resolves.toBeUndefined();
  });

  it('throws on non-404 HTTP errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(deactivateStreamChatUsers('key', 'secret', ['user-1'])).rejects.toThrow('500');
  });
});

describe('reactivateStreamChatUsers', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it('POSTs to /api/v2/users/{id}/reactivate for each user', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await reactivateStreamChatUsers('my-key', 'my-secret', ['user-1', 'bot-user-1']);

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [url1, opts1] = mockFetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url1).toBe(
      'https://chat.stream-io-api.com/api/v2/users/user-1/reactivate?api_key=my-key'
    );
    expect(opts1.method).toBe('POST');
    expect(opts1.headers['Stream-Auth-Type']).toBe('jwt');

    const [url2] = mockFetch.mock.calls[1] as [string, unknown];
    expect(url2).toBe(
      'https://chat.stream-io-api.com/api/v2/users/bot-user-1/reactivate?api_key=my-key'
    );
  });

  it('silently ignores 404 responses', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => 'Not Found' });

    await expect(
      reactivateStreamChatUsers('key', 'secret', ['nonexistent'])
    ).resolves.toBeUndefined();
  });

  it('throws on non-404 HTTP errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(reactivateStreamChatUsers('key', 'secret', ['user-1'])).rejects.toThrow('500');
  });
});

describe('setupDefaultStreamChatChannel', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  function mockOk() {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  }

  it('reactivates, upserts, creates channel, and returns correct IDs and bot token', async () => {
    mockOk();
    const result = await setupDefaultStreamChatChannel('api-key', 'api-secret', 'sandbox-abc');

    // 4 fetch calls: 2x reactivate + upsertUsers + getOrCreateChannel
    expect(mockFetch).toHaveBeenCalledTimes(4);

    // First two calls are reactivate (human + bot)
    const [reactivateUrl1] = mockFetch.mock.calls[0] as [string, unknown];
    expect(reactivateUrl1).toContain('/api/v2/users/sandbox-abc/reactivate');
    const [reactivateUrl2] = mockFetch.mock.calls[1] as [string, unknown];
    expect(reactivateUrl2).toContain('/api/v2/users/bot-sandbox-abc/reactivate');

    expect(result.apiKey).toBe('api-key');
    expect(result.botUserId).toBe('bot-sandbox-abc');
    expect(result.channelId).toBe('default-sandbox-abc');

    // Bot token should be a valid JWT; human user token is no longer returned
    const botPayload = decodeJwtPayload(result.botUserToken);
    expect(botPayload.user_id).toBe('bot-sandbox-abc');
    expect(result).not.toHaveProperty('userToken');
  });

  it('uses correct channel type (messaging)', async () => {
    mockOk();
    await setupDefaultStreamChatChannel('key', 'secret', 'sandbox-xyz');

    // Channel creation is the 4th call (after 2 reactivate + 1 upsert)
    const [channelUrl] = mockFetch.mock.calls[3] as [string, unknown];
    expect(channelUrl).toContain('/channels/messaging/');
    expect(channelUrl).toContain('default-sandbox-xyz');
  });

  it('throws if upsertUsers fails', async () => {
    // First two calls (reactivate) succeed, third (upsert) fails
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 }) // reactivate human
      .mockResolvedValueOnce({ ok: true, status: 200 }) // reactivate bot
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

    await expect(setupDefaultStreamChatChannel('key', 'secret', 'sandbox-fail')).rejects.toThrow(
      '500'
    );
  });

  it('throws if getOrCreateChannel fails', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 }) // reactivate human
      .mockResolvedValueOnce({ ok: true, status: 200 }) // reactivate bot
      .mockResolvedValueOnce({ ok: true, status: 200 }) // upsertUsers succeeds
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      });

    await expect(setupDefaultStreamChatChannel('key', 'secret', 'sandbox-fail2')).rejects.toThrow(
      '503'
    );
  });

  it('tolerates reactivate 404 (first provision, users do not exist yet)', async () => {
    // Reactivate returns 404, upsert and channel creation succeed
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not Found' }) // reactivate human
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not Found' }) // reactivate bot
      .mockResolvedValueOnce({ ok: true, status: 200 }) // upsertUsers
      .mockResolvedValueOnce({ ok: true, status: 200 }); // getOrCreateChannel

    const result = await setupDefaultStreamChatChannel('api-key', 'api-secret', 'sandbox-new');
    expect(result.apiKey).toBe('api-key');
    expect(result.botUserId).toBe('bot-sandbox-new');
  });
});
