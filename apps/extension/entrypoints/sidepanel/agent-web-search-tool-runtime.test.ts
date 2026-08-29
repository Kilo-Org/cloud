import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@/src/shared/auth';
import { ExecutionStoppedError } from '@/src/shared/agent-tool-results';
import {
  createWebSearchExecutor,
  executeWebSearchToolCall,
  MAX_SEARCHES_PER_TURN,
} from './agent-web-search-tool-runtime';

const webSearchCall = (query?: string) => (query === undefined ? {} : { query });

const jsonResponse = (status: number, body: unknown): Response => Response.json(body, { status });

const context = (fetchMock: FetchLike) => ({
  apiBaseUrl: 'https://app.kilo.ai',
  fetch: fetchMock,
  organizationId: 'org-1',
  token: 'token-1',
});

describe('web search tool runtime', () => {
  it('propagates AbortError from an issued search', async () => {
    const error = new DOMException('Stopped.', 'AbortError');
    const fetchMock = vi.fn<FetchLike>().mockRejectedValue(error);
    await expect(
      executeWebSearchToolCall(webSearchCall('anything'), context(fetchMock))
    ).rejects.toBe(error);
  });

  it.each([
    { reason: 'lease_lost', status: 'interrupted' as const },
    { reason: 'owner_cancelled', status: 'cancelled' as const },
  ])('retains $reason and uncertainty when an issued search aborts', async ({ reason, status }) => {
    const controller = new AbortController();
    const request = Promise.withResolvers<Response>();
    const fetchMock = vi.fn<FetchLike>((_input, init) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          request.reject(init.signal?.reason);
        },
        {
          once: true,
        }
      );
      return request.promise;
    });
    const pending = executeWebSearchToolCall(webSearchCall('anything'), {
      ...context(fetchMock),
      signal: controller.signal,
    });
    controller.abort(new ExecutionStoppedError(reason, status));

    await expect(pending).rejects.toMatchObject({ effectsUncertain: true, reason, status });
  });

  it.each([
    { effectsUncertain: true, status: 200 },
    { effectsUncertain: false, status: 402 },
  ])(
    'retains typed cancellation while reading a $status response',
    async ({ effectsUncertain, status }) => {
      const controller = new AbortController();
      const fetchMock = vi.fn<FetchLike>(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(body) {
                controller.signal.addEventListener(
                  'abort',
                  () => {
                    body.error(controller.signal.reason);
                  },
                  {
                    once: true,
                  }
                );
              },
            }),
            { headers: { 'Content-Type': 'application/json' }, status }
          )
      );
      const pending = executeWebSearchToolCall(webSearchCall('anything'), {
        ...context(fetchMock),
        signal: controller.signal,
      });
      controller.abort(new ExecutionStoppedError('lease_lost'));

      await expect(pending).rejects.toMatchObject({
        effectsUncertain,
        reason: 'lease_lost',
        status: 'interrupted',
      });
    }
  );

  it.each([
    { error: new Error('lease_lost'), label: 'legacy guard error' },
    { error: new ExecutionStoppedError('lease_lost'), label: 'typed guard error' },
  ])('keeps pre-dispatch rejection confirmed for a $label', async ({ error }) => {
    const fetchMock = vi.fn<FetchLike>();
    const runSearch = createWebSearchExecutor({
      ...context(fetchMock),
      executionGuard: () => {
        throw error;
      },
    });
    await expect(runSearch({ query: 'anything' })).rejects.toMatchObject({
      effectsUncertain: false,
      reason: 'lease_lost',
      status: 'interrupted',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the query to the Exa proxy and returns compact results', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(200, {
        costDollars: { total: 0.005 },
        results: [
          {
            publishedDate: '2020-01-01',
            text: 'The Eiffel Tower was completed in 1889.',
            title: 'Eiffel Tower',
            url: 'https://example.org/eiffel',
          },
        ],
      })
    );

    const result = await executeWebSearchToolCall(webSearchCall('eiffel tower'), {
      ...context(fetchMock),
    });

    expect(result).toStrictEqual({
      effectsUncertain: false,
      ok: true,
      value: {
        results: [
          {
            publishedDate: '2020-01-01',
            text: 'The Eiffel Tower was completed in 1889.',
            title: 'Eiffel Tower',
            url: 'https://example.org/eiffel',
          },
        ],
      },
    });
    expect(fetchMock).toHaveBeenCalledWith('https://app.kilo.ai/api/exa/search', {
      body: JSON.stringify({
        contents: { text: { maxCharacters: 1200 } },
        numResults: 5,
        query: 'eiffel tower',
      }),
      headers: {
        Authorization: 'Bearer token-1',
        'Content-Type': 'application/json',
        'x-kilocode-organizationid': 'org-1',
      },
      method: 'POST',
    });
  });

  it('requires a query', async () => {
    const fetchMock = vi.fn<FetchLike>();
    const result = await executeWebSearchToolCall(webSearchCall('  '), {
      ...context(fetchMock),
    });
    expect(result).toStrictEqual({
      effectsUncertain: false,
      error: 'Search query is required.',
      ok: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the backend error message on a non-ok response', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        jsonResponse(402, { error: 'Exa free allowance exhausted and no credit balance available' })
      );
    const result = await executeWebSearchToolCall(webSearchCall('anything'), {
      ...context(fetchMock),
    });
    expect(result).toStrictEqual({
      effectsUncertain: false,
      error:
        'Web search failed with status 402. Exa free allowance exhausted and no credit balance available',
      ok: false,
    });
  });

  it('reports an empty result set explicitly', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { results: [] }));
    const result = await executeWebSearchToolCall(webSearchCall('gibberish'), {
      ...context(fetchMock),
    });
    expect(result).toStrictEqual({
      effectsUncertain: false,
      ok: true,
      value: { message: 'No results found. Try a different query.', results: [] },
    });
  });

  it('rejects an invalid response shape', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { unexpected: true }));
    const result = await executeWebSearchToolCall(webSearchCall('anything'), {
      ...context(fetchMock),
    });
    expect(result).toStrictEqual({
      effectsUncertain: true,
      error: 'Web search returned an invalid response.',
      ok: false,
    });
  });

  it('returns a tool error on network failure', async () => {
    const fetchMock = vi.fn<FetchLike>().mockRejectedValue(new Error('offline'));
    const result = await executeWebSearchToolCall(webSearchCall('anything'), {
      ...context(fetchMock),
    });
    expect(result).toStrictEqual({
      effectsUncertain: true,
      error: 'Web search failed: offline',
      ok: false,
    });
  });
});

describe('web search executor', () => {
  // A Response body reads once, so every call needs a fresh one.
  const okFetch = () =>
    vi.fn<FetchLike>(() => jsonResponse(200, { results: [{ url: 'https://example.org/a' }] }));

  it('forwards the turn abort signal so a stopped turn does not leave a billable request', async () => {
    const controller = new AbortController();
    const fetchMock = okFetch();
    const runSearch = createWebSearchExecutor({
      ...context(fetchMock),
      signal: controller.signal,
    });

    await runSearch({ query: 'anything' });

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it('caps how many searches one turn may bill', async () => {
    const fetchMock = okFetch();
    const runSearch = createWebSearchExecutor(context(fetchMock));

    for (let index = 0; index < MAX_SEARCHES_PER_TURN; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- the cap is sequential by definition
      const allowed = await runSearch({ query: `query ${String(index)}` });
      expect(allowed.ok).toBe(true);
    }

    const blocked = await runSearch({ query: 'one too many' });

    expect(blocked.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_SEARCHES_PER_TURN);
  });
});
