import { describe, expect, it } from 'vitest';
import type { FetchLike } from './auth';
import {
  addModelFavorite,
  classifyModelPreferencesError,
  fetchModelPreferences,
  ModelPreferencesError,
  removeModelFavorite,
} from './model-preferences-client';

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  Response.json(body, { ...init });
const favoritesEnvelope = (favorites: string[] = []) =>
  jsonResponse({ result: { data: { favorites, lastSelected: null } } });
const mutationEnvelope = () => jsonResponse({ result: { data: { success: true } } });

const firstRequest = <Request>(requests: Request[]): Request => {
  const [request] = requests;
  if (request === undefined) {
    throw new Error('Expected request to be captured.');
  }
  return request;
};

interface CapturedRequest {
  readonly body: string | undefined;
  readonly headers: Headers;
  readonly input: string;
  readonly method: string | undefined;
}

const captureFetch = (
  handler: (request: CapturedRequest) => Response | Promise<Response>
): { readonly fetch: FetchLike; readonly seen: CapturedRequest[] } => {
  const seen: CapturedRequest[] = [];
  return {
    fetch: (input, init) => {
      const request: CapturedRequest = {
        body: typeof init?.body === 'string' ? init.body : undefined,
        headers: new Headers(init?.headers),
        input: String(input),
        method: init?.method,
      };
      seen.push(request);
      return handler(request);
    },
    seen,
  };
};

const networkFetch: FetchLike = () => {
  throw new TypeError('Failed to fetch');
};

const expectModelPreferencesError = async (
  run: () => Promise<unknown>,
  assert: (error: ModelPreferencesError) => void
): Promise<void> => {
  await expect(run()).rejects.toSatisfy((error: unknown) => {
    if (!(error instanceof ModelPreferencesError)) {
      throw new Error('expected ModelPreferencesError');
    }
    assert(error);
    return true;
  });
};

const clientOpts = (fetch: FetchLike) => ({
  apiBaseUrl: 'https://app.kilo.ai',
  fetch,
  token: 'token-1',
});

const classify = (status: number | null, trpcCode: string | null) =>
  classifyModelPreferencesError(new ModelPreferencesError('x', { status, trpcCode }));

const trpcError = ({
  code,
  httpStatus,
  message,
  rpcCode,
}: {
  readonly code: string;
  readonly httpStatus: number;
  readonly message: string;
  readonly rpcCode: number;
}) =>
  jsonResponse(
    { error: { code: rpcCode, data: { code, httpStatus }, message } },
    { status: httpStatus }
  );

describe('model preferences client', () => {
  it('fetches personal preferences without an input query param', async () => {
    const { fetch, seen } = captureFetch(() => favoritesEnvelope(['anthropic/claude-sonnet-4']));
    await expect(
      fetchModelPreferences({ apiBaseUrl: 'https://app.kilo.ai/', fetch, token: 'token-1' })
    ).resolves.toStrictEqual({
      favorites: ['anthropic/claude-sonnet-4'],
      lastSelected: null,
    });
    const request = firstRequest(seen);
    expect(request.input).toBe('https://app.kilo.ai/api/trpc/modelPreferences.get');
    expect(request.input).not.toContain('batch');
    expect(Object.fromEntries(request.headers.entries())).toMatchObject({
      accept: 'application/json',
      authorization: 'Bearer token-1',
    });
    expect(request.headers.has('x-kilocode-organizationid')).toBe(false);
  });

  it('scopes org get via tRPC input and never sends the org header', async () => {
    const { fetch, seen } = captureFetch(() => favoritesEnvelope());
    await fetchModelPreferences({ ...clientOpts(fetch), organizationId: 'org-1' });
    const request = firstRequest(seen);
    expect(request.input).toBe(
      `https://app.kilo.ai/api/trpc/modelPreferences.get?input=${encodeURIComponent(
        JSON.stringify({ organizationId: 'org-1' })
      )}`
    );
    expect(request.input).toContain('input=%7B%22organizationId%22%3A%22org-1%22%7D');
    expect(request.input).not.toContain('batch');
    expect(request.headers.has('x-kilocode-organizationid')).toBe(false);
  });

  it('parses a populated lastSelected object without breaking', async () => {
    const { fetch } = captureFetch(() =>
      jsonResponse({
        result: {
          data: { favorites: ['model-a'], lastSelected: { model: 'model-a', variant: 'high' } },
        },
      })
    );
    // The lastSelected value passes through so the new-session form can reuse
    // This request instead of issuing its own.
    await expect(fetchModelPreferences(clientOpts(fetch))).resolves.toStrictEqual({
      favorites: ['model-a'],
      lastSelected: { model: 'model-a', variant: 'high' },
    });
  });

  it('posts add favorite with raw model JSON and no batch or org header', async () => {
    const { fetch, seen } = captureFetch(() => mutationEnvelope());
    await addModelFavorite({
      ...clientOpts(fetch),
      apiBaseUrl: 'https://app.kilo.ai/',
      model: 'anthropic/claude-sonnet-4',
      organizationId: 'org-1',
    });
    const request = firstRequest(seen);
    expect({
      authorization: request.headers.get('authorization'),
      body: request.body,
      contentType: request.headers.get('content-type'),
      hasOrgHeader: request.headers.has('x-kilocode-organizationid'),
      input: request.input,
      method: request.method,
    }).toStrictEqual({
      authorization: 'Bearer token-1',
      body: '{"model":"anthropic/claude-sonnet-4"}',
      contentType: 'application/json',
      hasOrgHeader: false,
      input: 'https://app.kilo.ai/api/trpc/modelPreferences.addFavorite',
      method: 'POST',
    });
    expect(request.input).not.toContain('batch');
  });

  it('posts remove favorite with raw model JSON and no batch param', async () => {
    const { fetch, seen } = captureFetch(() => mutationEnvelope());
    await removeModelFavorite({
      ...clientOpts(fetch),
      apiBaseUrl: 'https://app.kilo.ai/',
      model: 'anthropic/claude-sonnet-4',
    });
    const request = firstRequest(seen);
    expect({
      body: request.body,
      contentType: request.headers.get('content-type'),
      input: request.input,
      method: request.method,
    }).toStrictEqual({
      body: '{"model":"anthropic/claude-sonnet-4"}',
      contentType: 'application/json',
      input: 'https://app.kilo.ai/api/trpc/modelPreferences.removeFavorite',
      method: 'POST',
    });
    expect(request.input).not.toContain('batch');
  });

  it('classifies HTTP and tRPC auth failures as terminal', () => {
    expect(classify(401, null)).toBe('terminal');
    expect(classify(403, null)).toBe('terminal');
    expect(classify(200, 'UNAUTHORIZED')).toBe('terminal');
    expect(classify(200, 'FORBIDDEN')).toBe('terminal');
  });

  it('classifies non-auth failures and unknown errors as retryable', () => {
    expect(classify(404, null)).toBe('retryable');
    expect(classify(500, null)).toBe('retryable');
    expect(classify(400, 'BAD_REQUEST')).toBe('retryable');
    expect(classifyModelPreferencesError(new Error('network'))).toBe('retryable');
  });

  it('maps network fetch failures to retryable ModelPreferencesError', async () => {
    await expectModelPreferencesError(
      () => fetchModelPreferences(clientOpts(networkFetch)),
      error => {
        expect(classifyModelPreferencesError(error)).toBe('retryable');
      }
    );
  });

  it('maps HTTP 404 without tRPC envelope to retryable status 404', async () => {
    const notFoundFetch = captureFetch(() => jsonResponse({ error: 'nope' }, { status: 404 }));
    await expectModelPreferencesError(
      () => fetchModelPreferences(clientOpts(notFoundFetch.fetch)),
      error => {
        expect(error.status).toBe(404);
        expect(classifyModelPreferencesError(error)).toBe('retryable');
      }
    );
  });

  it('maps tRPC INTERNAL_SERVER_ERROR envelope to retryable', async () => {
    const serverErrorFetch = captureFetch(() =>
      trpcError({
        code: 'INTERNAL_SERVER_ERROR',
        httpStatus: 500,
        message: 'boom',
        rpcCode: -32_603,
      })
    );
    await expectModelPreferencesError(
      () => fetchModelPreferences(clientOpts(serverErrorFetch.fetch)),
      error => {
        expect(classifyModelPreferencesError(error)).toBe('retryable');
      }
    );
  });

  it('maps tRPC UNAUTHORIZED envelope to terminal with trpcCode', async () => {
    const unauthorizedEnvelopeFetch = captureFetch(() =>
      trpcError({
        code: 'UNAUTHORIZED',
        httpStatus: 401,
        message: 'Unauthorized',
        rpcCode: -32_001,
      })
    );
    await expectModelPreferencesError(
      () => fetchModelPreferences(clientOpts(unauthorizedEnvelopeFetch.fetch)),
      error => {
        expect(error.trpcCode).toBe('UNAUTHORIZED');
        expect(classifyModelPreferencesError(error)).toBe('terminal');
      }
    );
  });

  it('maps malformed success envelopes to retryable ModelPreferencesError', async () => {
    const malformedFetch = captureFetch(() => jsonResponse({ not: 'an envelope' }));
    await expectModelPreferencesError(
      () => fetchModelPreferences(clientOpts(malformedFetch.fetch)),
      error => {
        expect(classifyModelPreferencesError(error)).toBe('retryable');
      }
    );
  });

  it('never adds a batch query parameter on get', async () => {
    const { fetch, seen } = captureFetch(() => favoritesEnvelope());
    await fetchModelPreferences({ ...clientOpts(fetch), organizationId: 'org-2' });
    expect(firstRequest(seen).input).not.toMatch(/[?&]batch=/);
  });

  it('never adds a batch query parameter on add favorite', async () => {
    const { fetch, seen } = captureFetch(() => mutationEnvelope());
    await addModelFavorite({ ...clientOpts(fetch), model: 'model-a' });
    expect(firstRequest(seen).input).not.toMatch(/[?&]batch=/);
  });

  it('never adds a batch query parameter on remove favorite', async () => {
    const { fetch, seen } = captureFetch(() => mutationEnvelope());
    await removeModelFavorite({ ...clientOpts(fetch), model: 'model-a' });
    expect(firstRequest(seen).input).not.toMatch(/[?&]batch=/);
  });
});
