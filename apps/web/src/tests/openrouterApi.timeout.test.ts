import { captureException, captureMessage } from '@sentry/nextjs';
import { upstreamRequest } from '../lib/ai-gateway/providers/upstream-request';
import PROVIDERS from '../lib/ai-gateway/providers/provider-definitions';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockCaptureException = jest.mocked(captureException);
const mockCaptureMessage = jest.mocked(captureMessage);
const originalFetch = global.fetch;

describe('upstreamRequest timeout', () => {
  beforeEach(() => {
    mockCaptureException.mockReset();
    mockCaptureMessage.mockReset();
    global.fetch = originalFetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('should abort after timeout', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      upstreamRequest({
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
      })
    ).rejects.toThrow();

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('returns a gateway timeout response for request timeout aborts', async () => {
    const timeoutError = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError'
    );
    const mockFetch = jest.fn().mockRejectedValue(timeoutError);
    global.fetch = mockFetch;

    const response = await upstreamRequest({
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

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: 'Gateway Timeout', error_type: 'upstream_error' })
    );

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

  it('returns a bad gateway response when diagnostic enrichment throws', async () => {
    const fetchError = new TypeError('fetch failed');
    Object.defineProperty(fetchError, 'cause', {
      get() {
        throw new Error('cause getter failed');
      },
    });
    const mockFetch = jest.fn().mockRejectedValue(fetchError);
    global.fetch = mockFetch;

    const response = await upstreamRequest({
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

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: 'Bad Gateway', error_type: 'upstream_error' })
    );

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

    const response = await upstreamRequest({
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

    expect(response.status).toBe(502);

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

  it('returns a gateway timeout response for ETIMEDOUT transport failures', async () => {
    const timeoutCause = Object.assign(new Error('socket read timed out'), {
      code: 'ETIMEDOUT',
      name: 'SocketTimeoutError',
    });
    const fetchError = new TypeError('fetch failed', { cause: timeoutCause });
    const mockFetch = jest.fn().mockRejectedValue(fetchError);
    global.fetch = mockFetch;

    const response = await upstreamRequest({
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

    expect(response.status).toBe(504);

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

  it('returns a gateway timeout response and captures safe timeout metadata', async () => {
    const timeoutCause = Object.assign(new Error('Headers Timeout Error'), {
      code: 'UND_ERR_HEADERS_TIMEOUT',
      name: 'HeadersTimeoutError',
    });
    const fetchError = new TypeError('fetch failed', { cause: timeoutCause });
    const mockFetch = jest.fn().mockRejectedValue(fetchError);
    global.fetch = mockFetch;

    const response = await upstreamRequest({
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

    expect(response.status).toBe(504);

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

  it('logs when the timeout signal fires and returns a gateway timeout response', async () => {
    const mockFetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const fetchSignal = init?.signal;
        if (!fetchSignal) return;
        const onAbort = () => reject(fetchSignal.reason);
        if (fetchSignal.aborted) {
          onAbort();
          return;
        }
        fetchSignal.addEventListener('abort', onAbort, { once: true });
      });
    });
    global.fetch = mockFetch;

    const response = await upstreamRequest({
      path: '/chat/completions',
      search: '',
      method: 'POST',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
      },
      extraHeaders: {},
      provider: PROVIDERS.OPENROUTER,
      timeoutMs: 25,
    });

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: 'Gateway Timeout', error_type: 'upstream_error' })
    );

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'AI gateway upstream request timed out',
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          source: 'ai-gateway-upstream-fetch',
          provider: 'openrouter',
          failure_family: 'request_timeout',
        }),
        extra: expect.objectContaining({
          providerId: 'openrouter',
          path: '/chat/completions',
          timeoutMs: 25,
        }),
      })
    );
  });
});
