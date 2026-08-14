import { captureException } from '@sentry/nextjs';
import { upstreamRequest } from '../lib/ai-gateway/providers/upstream-request';
import PROVIDERS from '../lib/ai-gateway/providers/provider-definitions';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// `upstreamRequest` schedules its timeout-listener cleanup through `next/server`'s
// `after()` post-response hook, which only works in a request context. Replace it
// with an immediate invocation so the test can run outside a request scope.
jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn((work: Promise<unknown> | (() => Promise<unknown>)) => {
    void (typeof work === 'function' ? work() : work);
  }),
}));

const mockCaptureException = jest.mocked(captureException);
const originalFetch = global.fetch;

describe('upstreamRequest timeout', () => {
  beforeEach(() => {
    mockCaptureException.mockReset();
    global.fetch = originalFetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test.each([
    {
      chatApi: 'messages',
      path: '/messages',
      apiUrlOverrides: { messages: 'https://messages.example.test/v3/v1' },
      expectedUrl: 'https://messages.example.test/v3/v1/messages?beta=true',
    },
    {
      chatApi: 'responses',
      path: '/responses',
      apiUrlOverrides: {},
      expectedUrl: 'https://gateway.example.test/v3/responses?beta=true',
    },
  ] as const)(
    'uses the $chatApi API URL override when provided',
    async ({ chatApi, path, apiUrlOverrides, expectedUrl }) => {
      const mockFetch = jest.fn().mockResolvedValue(new Response('{}'));
      global.fetch = mockFetch;

      const result = await upstreamRequest({
        chatApi,
        path,
        search: '?beta=true',
        method: 'POST',
        body: { model: 'test-model', messages: [{ role: 'user', content: 'test' }] },
        extraHeaders: {},
        provider: {
          ...PROVIDERS.OPENROUTER,
          apiUrl: 'https://gateway.example.test/v3',
          apiUrlOverrides,
        },
      });

      expect(result.type).toBe('success');
      expect(mockFetch).toHaveBeenCalledWith(expectedUrl, expect.any(Object));
    }
  );

  it('reports a client disconnect instead of an upstream disconnect when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await upstreamRequest({
      chatApi: 'chat_completions',
      path: '/chat/completions',
      search: '',
      method: 'POST',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
      },
      extraHeaders: {},
      provider: PROVIDERS.OPENROUTER,
      signal: controller.signal,
    });

    expect(result.type).toBe('error');
    expect(mockCaptureException).not.toHaveBeenCalled();
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.response.status).toBe(499);
    await expect(result.response.json()).resolves.toEqual({
      error:
        'The client disconnected before the upstream provider responded, so the request was cancelled. The upstream provider did not fail.',
      error_type: 'client_disconnect',
      message:
        'The client disconnected before the upstream provider responded, so the request was cancelled. The upstream provider did not fail.',
    });
  });

  it('reports a gateway timeout message when the upstream sends no response headers', async () => {
    const timeoutError = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError'
    );
    global.fetch = jest.fn().mockRejectedValue(timeoutError);

    const result = await upstreamRequest({
      chatApi: 'chat_completions',
      path: '/chat/completions',
      search: '',
      method: 'POST',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
      },
      extraHeaders: {},
      provider: PROVIDERS.OPENROUTER,
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.response.status).toBe(503);
    await expect(result.response.json()).resolves.toEqual({
      error: 'The upstream provider did not send response headers before the gateway timeout.',
      error_type: 'upstream_disconnect',
      message: 'The upstream provider did not send response headers before the gateway timeout.',
    });
  });

  it('reports an upstream disconnect when the upstream connection fails', async () => {
    const resetCause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    global.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('fetch failed', { cause: resetCause }));

    const result = await upstreamRequest({
      chatApi: 'chat_completions',
      path: '/chat/completions',
      search: '',
      method: 'POST',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
      },
      extraHeaders: {},
      provider: PROVIDERS.OPENROUTER,
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.response.status).toBe(503);
    await expect(result.response.json()).resolves.toEqual({
      error: 'The upstream provider closed the connection before sending a response.',
      error_type: 'upstream_disconnect',
      message: 'The upstream provider closed the connection before sending a response.',
    });
  });

  it('includes the vercel request id in the error message and failure metadata', async () => {
    const resetCause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    global.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('fetch failed', { cause: resetCause }));

    const result = await upstreamRequest({
      chatApi: 'chat_completions',
      path: '/chat/completions',
      search: '',
      method: 'POST',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
      },
      extraHeaders: {},
      provider: PROVIDERS.OPENROUTER,
      vercelRequestId: 'iad1::iad1::request-id',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    await expect(result.response.json()).resolves.toEqual({
      error:
        'The upstream provider closed the connection before sending a response. (request id: iad1::iad1::request-id)',
      error_type: 'upstream_disconnect',
      message:
        'The upstream provider closed the connection before sending a response. (request id: iad1::iad1::request-id)',
      vercel_request_id: 'iad1::iad1::request-id',
    });
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        extra: expect.objectContaining({ vercelRequestId: 'iad1::iad1::request-id' }),
      })
    );
  });

  it('includes the vercel request id when the client disconnects', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await upstreamRequest({
      chatApi: 'chat_completions',
      path: '/chat/completions',
      search: '',
      method: 'POST',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
      },
      extraHeaders: {},
      provider: PROVIDERS.OPENROUTER,
      signal: controller.signal,
      vercelRequestId: 'iad1::iad1::request-id',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.response.status).toBe(499);
    await expect(result.response.json()).resolves.toMatchObject({
      error_type: 'client_disconnect',
      vercel_request_id: 'iad1::iad1::request-id',
    });
  });

  it('classifies request timeout aborts separately', async () => {
    const timeoutError = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError'
    );
    const mockFetch = jest.fn().mockRejectedValue(timeoutError);
    global.fetch = mockFetch;

    const result = await upstreamRequest({
      chatApi: 'chat_completions',
      path: '/chat/completions',
      search: '',
      method: 'POST',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
      },
      extraHeaders: {},
      provider: PROVIDERS.OPENROUTER,
    });

    expect(result.type).toBe('error');

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'TimeoutError',
        message: 'The operation was aborted due to timeout',
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ failure_family: 'request_timeout' }),
        extra: expect.objectContaining({ failureFamily: 'request_timeout' }),
      })
    );
  });

  it('preserves fetch failures when diagnostic enrichment throws', async () => {
    const fetchError = new TypeError('fetch failed');
    Object.defineProperty(fetchError, 'cause', {
      get() {
        throw new Error('cause getter failed');
      },
    });
    const mockFetch = jest.fn().mockRejectedValue(fetchError);
    global.fetch = mockFetch;

    const result = await upstreamRequest({
      chatApi: 'chat_completions',
      path: '/chat/completions',
      search: '',
      method: 'POST',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
      },
      extraHeaders: {},
      provider: PROVIDERS.OPENROUTER,
    });

    expect(result.type).toBe('error');
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('redacts URLs from captured fetch and cause messages', async () => {
    const resetCause = Object.assign(
      new Error('socket reset at https://gateway.example.test/v1?cause=cause-secret'),
      {
        code: 'ECONNRESET',
        name: 'SocketResetError',
      }
    );
    const fetchError = new TypeError(
      'fetch failed for https://gateway.example.test/v1?error=error-secret',
      { cause: resetCause }
    );
    const mockFetch = jest.fn().mockRejectedValue(fetchError);
    global.fetch = mockFetch;

    const result = await upstreamRequest({
      chatApi: 'chat_completions',
      path: '/chat/completions',
      search: '?trace=search-secret',
      method: 'POST',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'body-secret-content' }],
      },
      extraHeaders: {},
      provider: {
        ...PROVIDERS.OPENROUTER,
        apiUrl: 'https://gateway.example.test/v1?token=url-secret',
      },
    });

    expect(result.type).toBe('error');

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'TypeError',
        message: 'fetch failed for [redacted-url]',
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ failure_family: 'conn_reset' }),
        extra: expect.objectContaining({
          failureFamily: 'conn_reset',
          errorMessage: 'fetch failed for [redacted-url]',
          causeMessage: 'socket reset at [redacted-url]',
        }),
      })
    );

    const capturedOptions = JSON.stringify(mockCaptureException.mock.calls[0]?.[1]);
    expect(capturedOptions).not.toContain('cause-secret');
    expect(capturedOptions).not.toContain('error-secret');
    expect(capturedOptions).not.toContain('url-secret');
    expect(capturedOptions).not.toContain('search-secret');
    expect(capturedOptions).not.toContain('body-secret-content');
  });

  it('classifies ETIMEDOUT transport failures as read timeouts', async () => {
    const timeoutCause = Object.assign(new Error('socket read timed out'), {
      code: 'ETIMEDOUT',
      name: 'SocketTimeoutError',
    });
    const fetchError = new TypeError('fetch failed', { cause: timeoutCause });
    const mockFetch = jest.fn().mockRejectedValue(fetchError);
    global.fetch = mockFetch;

    const result = await upstreamRequest({
      chatApi: 'chat_completions',
      path: '/chat/completions',
      search: '',
      method: 'POST',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
      },
      extraHeaders: {},
      provider: PROVIDERS.OPENROUTER,
    });

    expect(result.type).toBe('error');

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'TypeError', message: 'fetch failed' }),
      expect.objectContaining({
        tags: expect.objectContaining({ failure_family: 'read_timeout' }),
        extra: expect.objectContaining({
          failureFamily: 'read_timeout',
          causeCode: 'ETIMEDOUT',
          causeName: 'SocketTimeoutError',
          causeMessage: 'socket read timed out',
        }),
      })
    );
  });

  it('captures safe timeout metadata on provider fetch failures', async () => {
    const timeoutCause = Object.assign(new Error('Headers Timeout Error'), {
      code: 'UND_ERR_HEADERS_TIMEOUT',
      name: 'HeadersTimeoutError',
    });
    const fetchError = new TypeError('fetch failed', { cause: timeoutCause });
    const mockFetch = jest.fn().mockRejectedValue(fetchError);
    global.fetch = mockFetch;

    const result = await upstreamRequest({
      chatApi: 'chat_completions',
      path: '/chat/completions',
      search: '?trace=search-secret',
      method: 'POST',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'body-secret-content' }],
      },
      extraHeaders: { 'x-safe-extra-header': 'extra-header-secret' },
      provider: {
        ...PROVIDERS.OPENROUTER,
        apiUrl: 'https://gateway.example.test/v1?token=url-secret',
        apiKey: 'provider-api-key-secret',
      },
    });

    expect(result.type).toBe('error');

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'TypeError', message: 'fetch failed' }),
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          source: 'ai-gateway-upstream-fetch',
          provider: 'openrouter',
          failure_family: 'headers_timeout',
        }),
        extra: expect.objectContaining({
          providerId: 'openrouter',
          targetHost: 'gateway.example.test',
          path: '/chat/completions',
          failureFamily: 'headers_timeout',
          errorName: 'TypeError',
          errorMessage: 'fetch failed',
          causeCode: 'UND_ERR_HEADERS_TIMEOUT',
          causeName: 'HeadersTimeoutError',
          causeMessage: 'Headers Timeout Error',
        }),
      })
    );

    const capturedOptions = JSON.stringify(mockCaptureException.mock.calls[0]?.[1]);
    expect(capturedOptions).not.toContain('provider-api-key-secret');
    expect(capturedOptions).not.toContain('url-secret');
    expect(capturedOptions).not.toContain('search-secret');
    expect(capturedOptions).not.toContain('body-secret-content');
    expect(capturedOptions).not.toContain('extra-header-secret');
  });
});
