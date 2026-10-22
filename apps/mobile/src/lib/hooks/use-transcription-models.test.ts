import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { TELEMETRY_DESCRIPTION_KEY } from '@/lib/telemetry/error-sink';

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

const DECLARED_OUTCOME_TAGS = {
  'error.subsystem': 'transcription-models',
  'error.operation': 'fetch',
};

/** The telemetry the app-wide QueryCache reporter reads off a rejection. */
async function declarationOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect((error as Record<string, unknown>)[TELEMETRY_DESCRIPTION_KEY]).toBeDefined();
    return error as Error;
  }
  throw new Error('Expected the transcription-models fetch to reject');
}

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

  it('declares an HTTP outcome for a failed gateway response', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'Failed' }, { status: 500, statusText: 'Internal Server Error' })
    );

    const error = await declarationOf(fetchTranscriptionModels());

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Failed to fetch transcription models: 500 Internal Server Error');
    expect(Reflect.get(error, TELEMETRY_DESCRIPTION_KEY)).toEqual({
      level: 'warning',
      fingerprint: ['transcription-models-fetch', 'http.500'],
      report: 'none',
      tags: { ...DECLARED_OUTCOME_TAGS, 'http.status': 500 },
    });
  });

  it('declares a transport outcome when the request never reaches the gateway', async () => {
    const transportFailure = new TypeError('Network request failed');
    fetchMock.mockRejectedValue(transportFailure);

    const error = await declarationOf(fetchTranscriptionModels());

    expect(error.message).toBe('Failed to reach the transcription models endpoint');
    expect(error.cause).toBe(transportFailure);
    expect(Reflect.get(error, TELEMETRY_DESCRIPTION_KEY)).toEqual({
      level: 'warning',
      fingerprint: ['transcription-models-fetch', 'transport'],
      report: 'none',
      tags: DECLARED_OUTCOME_TAGS,
    });
  });

  it('declares a timeout outcome when the request exceeds 15s', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_url, init) => {
      const aborted = Promise.withResolvers<never>();
      init?.signal?.addEventListener('abort', () => {
        aborted.reject(new Error('Aborted'));
      });
      await aborted.promise;
      return Response.json(GATEWAY_BODY);
    });

    const pending = declarationOf(fetchTranscriptionModels());
    await vi.advanceTimersByTimeAsync(15_000);
    const error = await pending;

    expect(error.message).toBe('Timed out fetching transcription models after 15000ms');
    expect(error.cause).toEqual(new Error('Aborted'));
    expect(Reflect.get(error, TELEMETRY_DESCRIPTION_KEY)).toEqual({
      level: 'warning',
      fingerprint: ['transcription-models-fetch', 'timeout'],
      tags: DECLARED_OUTCOME_TAGS,
    });
  });

  it('declares a contract mismatch as an error, keeping the parse failure as cause', async () => {
    fetchMock.mockResolvedValue(Response.json({ models: [] }));

    const error = await declarationOf(fetchTranscriptionModels());

    expect(error.cause).toBeInstanceOf(ZodError);
    expect(Reflect.get(error, TELEMETRY_DESCRIPTION_KEY)).toEqual({
      level: 'error',
      fingerprint: ['transcription-models-fetch', 'invalid-response'],
      tags: DECLARED_OUTCOME_TAGS,
    });
  });

  it('declares a body that is not JSON as a contract failure, not a transport one', async () => {
    fetchMock.mockResolvedValue(new Response('<html>proxy error</html>', { status: 200 }));

    const error = await declarationOf(fetchTranscriptionModels());

    expect(error.message).toBe('Transcription models response was not valid JSON');
    expect(error.cause).toBeInstanceOf(SyntaxError);
    expect(Reflect.get(error, TELEMETRY_DESCRIPTION_KEY)).toEqual({
      level: 'error',
      fingerprint: ['transcription-models-fetch', 'invalid-response'],
      tags: DECLARED_OUTCOME_TAGS,
    });
  });

  it('leaves an expected answer to the network layer', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' })
    );

    const error = await declarationOf(fetchTranscriptionModels());

    expect(Reflect.get(error, TELEMETRY_DESCRIPTION_KEY)).toEqual({
      level: 'warning',
      fingerprint: ['transcription-models-fetch', 'http.401'],
      report: 'none',
      tags: { ...DECLARED_OUTCOME_TAGS, 'http.status': 401 },
    });
  });

  it('keeps a response status that arrived while the deadline fired', async () => {
    vi.useFakeTimers();
    const arrived = Promise.withResolvers<undefined>();
    fetchMock.mockImplementation(async () => {
      await arrived.promise;
      return Response.json(
        { error: 'Failed' },
        { status: 500, statusText: 'Internal Server Error' }
      );
    });

    const pending = declarationOf(fetchTranscriptionModels());
    await vi.advanceTimersByTimeAsync(15_000);
    arrived.resolve(undefined);
    const error = await pending;

    expect(Reflect.get(error, TELEMETRY_DESCRIPTION_KEY)).toEqual({
      level: 'warning',
      fingerprint: ['transcription-models-fetch', 'http.500'],
      report: 'none',
      tags: { ...DECLARED_OUTCOME_TAGS, 'http.status': 500 },
    });
  });
});
