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
  apiUrlOverrides: {},
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
});
