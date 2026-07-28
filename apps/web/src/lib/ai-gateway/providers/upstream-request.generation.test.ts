import { captureException } from '@sentry/nextjs';
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
  id: 'openrouter',
  apiUrl: 'https://openrouter.example/api/v1',
  apiKey: 'test-api-key',
  supportedChatApis: [],
  transformRequest: async () => {},
};

const mockCaptureException = jest.mocked(captureException);
const mockFetchWithBackoff = jest.mocked(fetchWithBackoff);

describe('fetchGeneration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockCaptureException.mockReset();
    mockFetchWithBackoff.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('polls for up to five minutes with a capped backoff', async () => {
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    mockFetchWithBackoff.mockResolvedValue(
      new Response(JSON.stringify({ id: 'generation-id' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = fetchGeneration('message-id', provider);
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual({ id: 'generation-id' });
    expect(timeoutSpy).toHaveBeenCalledWith(5 * 60 * 1_000);
    expect(mockFetchWithBackoff).toHaveBeenCalledWith(
      'https://openrouter.example/api/v1/generation?id=message-id',
      {
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-api-key' }),
        signal: timeoutSignal,
      },
      expect.objectContaining({
        attemptTimeoutMs: 10_000,
        baseDelayMs: 2_000,
        maxBackoffDelayMs: 15_000,
        maxDelayMs: 5 * 60 * 1_000 - 1_000,
      })
    );

    const retryResponse = mockFetchWithBackoff.mock.calls[0]?.[2]?.retryResponse;
    expect(retryResponse?.(new Response(null, { status: 404 }))).toBe(true);
    expect(retryResponse?.(new Response(null, { status: 429 }))).toBe(true);
    expect(retryResponse?.(new Response(null, { status: 500 }))).toBe(true);
    expect(retryResponse?.(new Response(null, { status: 401 }))).toBe(false);
    expect(retryResponse?.(new Response(null, { status: 200 }))).toBe(false);
  });
});
