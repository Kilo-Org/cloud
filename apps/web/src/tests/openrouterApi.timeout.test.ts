import { captureException } from '@sentry/nextjs';
import { upstreamRequest } from '../lib/ai-gateway/providers/upstream-request';
import PROVIDERS from '../lib/ai-gateway/providers/provider-definitions';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
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
  });

  it('rethrows provider fetch failures and captures safe timeout metadata', async () => {
    const timeoutCause = Object.assign(new Error('Headers Timeout Error'), {
      code: 'UND_ERR_HEADERS_TIMEOUT',
      name: 'HeadersTimeoutError',
    });
    const fetchError = new TypeError('fetch failed', { cause: timeoutCause });
    const mockFetch = jest.fn().mockRejectedValue(fetchError);
    global.fetch = mockFetch;

    await expect(
      upstreamRequest({
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
      })
    ).rejects.toBe(fetchError);

    expect(mockCaptureException).toHaveBeenCalledWith(
      fetchError,
      expect.objectContaining({
        level: 'error',
        tags: {
          source: 'ai-gateway-upstream-fetch',
          provider: 'openrouter',
          failure_family: 'headers_timeout',
        },
        extra: {
          providerId: 'openrouter',
          targetHost: 'gateway.example.test',
          path: '/chat/completions',
          failureFamily: 'headers_timeout',
          errorName: 'TypeError',
          errorMessage: 'fetch failed',
          causeCode: 'UND_ERR_HEADERS_TIMEOUT',
          causeName: 'HeadersTimeoutError',
          causeMessage: 'Headers Timeout Error',
        },
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
