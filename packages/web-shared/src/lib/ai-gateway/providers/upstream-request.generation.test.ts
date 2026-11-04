import { captureMessage } from '@sentry/nextjs';
import { fetchWithBackoff } from '../../fetchWithBackoff';
import { fetchGeneration } from './upstream-request';
import type { Provider } from './types';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('../../debugUtils', () => ({
  debugSaveProxyResponseStream: jest.fn(),
}));

jest.mock('../../fetchWithBackoff', () => ({
  fetchWithBackoff: jest.fn(),
}));

const provider: Provider = {
  type: 'openrouter',
  apiUrl: 'https://openrouter.example/api/v1',
  apiUrlOverrides: {},
  disableUrlSuffix: false,
  apiKey: 'test-api-key',
  apiKeyHeader: null,
  supportedChatApis: [],
  responseTransforms: null,
  transformRequest: async () => {},
};

const mockFetchWithBackoff = jest.mocked(fetchWithBackoff);

describe('fetchGeneration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockFetchWithBackoff.mockReset();
    jest.mocked(captureMessage).mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('limits generation polling to about one minute', async () => {
    mockFetchWithBackoff.mockResolvedValue(
      new Response(JSON.stringify({ id: 'generation-id' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = fetchGeneration('message-id', provider);
    await jest.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toEqual({ id: 'generation-id' });
    expect(mockFetchWithBackoff).toHaveBeenCalledWith(
      'https://openrouter.example/api/v1/generation?id=message-id',
      {
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-api-key' }),
      },
      expect.objectContaining({
        baseDelayMs: 5_000,
        maxDelayMs: 75 * 1_000,
      })
    );

    const retryResponse = mockFetchWithBackoff.mock.calls[0]?.[2]?.retryResponse;
    expect(retryResponse?.(new Response(null, { status: 404 }))).toBe(true);
    expect(retryResponse?.(new Response(null, { status: 200 }))).toBe(false);
  });

  it('cancels a failed generation response without including its body in the report', async () => {
    const privateResponseText = 'synthetic-response-secret@example.test';
    const cancel = jest.fn();
    mockFetchWithBackoff.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(privateResponseText));
          },
          cancel,
        }),
        { status: 503, statusText: 'Service Unavailable' }
      )
    );

    const result = fetchGeneration('message-id', provider);
    await jest.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'Timed out fetching openrouter generation',
      expect.objectContaining({
        level: 'info',
        tags: { source: 'openrouter_generation_fetch' },
        extra: {
          messageId: 'message-id',
          status: 503,
          statusText: 'Service Unavailable',
        },
      })
    );
    expect(JSON.stringify(jest.mocked(captureMessage).mock.calls)).not.toContain(
      privateResponseText
    );
  });
});
