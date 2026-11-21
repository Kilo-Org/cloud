import { fetchWithBackoff } from '../../fetchWithBackoff';
import { captureMessage } from '@sentry/nextjs';
import { fetchGeneration } from './upstream-request';
import type { Provider } from './types';
import { VERCEL_AI_GATEWAY } from './definitions/vercel';

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
  apiUrl: 'https://openrouter.ai/api/v1',
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
      'https://openrouter.ai/api/v1/generation?id=message-id',
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

  it('encodes the message id in the query string', async () => {
    mockFetchWithBackoff.mockResolvedValue(
      new Response(JSON.stringify({ id: 'generation-id' }), { status: 200 })
    );

    const result = fetchGeneration('gen-1&api_key=x#frag ?', provider);
    await jest.advanceTimersByTimeAsync(200);
    await result;

    expect(mockFetchWithBackoff.mock.calls[0]?.[0]).toBe(
      'https://openrouter.ai/api/v1/generation?id=gen-1%26api_key%3Dx%23frag%20%3F'
    );
  });

  it('looks generations up on the Vercel AI gateway', async () => {
    mockFetchWithBackoff.mockResolvedValue(
      new Response(JSON.stringify({ id: 'generation-id' }), { status: 200 })
    );

    const result = fetchGeneration('message-id', {
      ...provider,
      type: 'vercel',
      apiUrl: VERCEL_AI_GATEWAY.apiUrl,
    });
    await jest.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toEqual({ id: 'generation-id' });
    expect(mockFetchWithBackoff.mock.calls[0]?.[0]).toBe(
      `${VERCEL_AI_GATEWAY.apiUrl}/generation?id=message-id`
    );
  });

  it.each([
    'https://evil.example/v1',
    'https://openrouter.ai.evil.example/api/v1',
    'http://openrouter.ai/api/v1',
    'https://openrouter.ai:8443/api/v1',
    'not a url',
  ])('skips the lookup, and the provider key, for the apiUrl %s', async apiUrl => {
    jest.mocked(captureMessage).mockClear();

    const result = fetchGeneration('message-id', { ...provider, apiUrl });
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toBeUndefined();
    expect(mockFetchWithBackoff).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('Skipped generation lookup'),
      expect.objectContaining({ level: 'warning' })
    );
  });
});
