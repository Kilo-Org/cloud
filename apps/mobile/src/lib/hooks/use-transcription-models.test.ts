import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchTranscriptionModels } from './use-transcription-models';

// Stub native/expo modules so pure-node Vitest can resolve the
// module graph when importing from use-transcription-models.ts
// (same stub set as use-available-models.test.ts).
vi.mock('expo-secure-store', () => ({}));
vi.mock('@tanstack/react-query', () => ({}));
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));

const getAuthTokenForRequest = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest }));

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());
vi.stubGlobal('fetch', fetchMock);

const GATEWAY_BODY = {
  data: [
    {
      id: 'openai/gpt-4o-transcribe',
      name: 'OpenAI: GPT-4o Transcribe',
      pricing: { prompt: '0.000001', completion: '0.000006' },
    },
    { id: 'kilo/whisper-large-v3', name: 'Whisper Large v3' },
  ],
};

beforeEach(() => {
  fetchMock.mockReset();
  getAuthTokenForRequest.mockReset();
  getAuthTokenForRequest.mockResolvedValue('token-1');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchTranscriptionModels', () => {
  it('parses the gateway response into shared model options', async () => {
    fetchMock.mockResolvedValue(Response.json(GATEWAY_BODY));

    const models = await fetchTranscriptionModels();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/gateway/transcription-models',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'openai/gpt-4o-transcribe',
      // The shared mapper strips the "OpenAI: " vendor prefix.
      name: 'GPT-4o Transcribe',
      pricing: { prompt: '0.000001', completion: '0.000006' },
      variants: [],
      isPreferred: false,
    });
    expect(models[1]).toMatchObject({ id: 'kilo/whisper-large-v3', name: 'Whisper Large v3' });
  });

  it('sorts and marks preferred models through the shared mapper', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          { id: 'a/second', name: 'Second' },
          { id: 'a/first', name: 'First', preferredIndex: 0 },
        ],
      })
    );

    const models = await fetchTranscriptionModels();

    expect(models.map(model => model.id)).toEqual(['a/first', 'a/second']);
    expect(models[0]?.isPreferred).toBe(true);
  });

  it('sends the auth token and the organization header only when set', async () => {
    // A fresh Response per call: a Response body can only be read once.
    fetchMock
      .mockResolvedValueOnce(Response.json(GATEWAY_BODY))
      .mockResolvedValueOnce(Response.json(GATEWAY_BODY))
      .mockResolvedValueOnce(Response.json(GATEWAY_BODY));

    await fetchTranscriptionModels('org-1');
    const call = fetchMock.mock.calls[0];
    expect(call?.[1]?.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer token-1',
      'X-KiloCode-OrganizationId': 'org-1',
    });

    await fetchTranscriptionModels();
    const anonymousCall = fetchMock.mock.calls[1];
    expect(anonymousCall?.[1]?.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer token-1',
    });

    getAuthTokenForRequest.mockResolvedValue(null);
    await fetchTranscriptionModels();
    const unauthenticatedCall = fetchMock.mock.calls[2];
    expect(unauthenticatedCall?.[1]?.headers).toEqual({ Accept: 'application/json' });
  });

  it('propagates an HTTP error from the gateway', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'Failed' }, { status: 500, statusText: 'Internal Server Error' })
    );

    await expect(fetchTranscriptionModels()).rejects.toThrow(
      'Failed to fetch transcription models: 500 Internal Server Error'
    );
  });

  it('propagates a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));

    await expect(fetchTranscriptionModels()).rejects.toThrow('Network request failed');
  });

  it('rejects with a timeout error when the request exceeds 15s', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('Aborted'));
        });
      });
      return Response.json(GATEWAY_BODY);
    });

    const pending = fetchTranscriptionModels();
    const expectation = expect(pending).rejects.toThrow(
      'Timed out fetching transcription models after 15000ms'
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await expectation;
  });

  it('rejects a body that is not the shared OpenRouter contract', async () => {
    fetchMock.mockResolvedValue(Response.json({ models: [] }));

    await expect(fetchTranscriptionModels()).rejects.toThrow();
  });
});
