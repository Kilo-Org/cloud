import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@/src/shared/auth';
import { executeWebSearchToolCall } from './agent-web-search-tool-runtime';

const webSearchCall = (query?: string) => (query === undefined ? {} : { query });

const jsonResponse = (status: number, body: unknown): Response =>
  Response.json(body, { status });

const context = (fetchMock: FetchLike) => ({
  apiBaseUrl: 'https://app.kilo.ai/',
  fetch: fetchMock,
  organizationId: 'org-1',
  token: 'token-1',
});

describe('web search tool runtime', () => {
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
    expect(result).toStrictEqual({ error: 'Search query is required.', ok: false });
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
      ok: true,
      value: { message: 'No results found. Try a different query.', results: [] },
    });
  });

  it('rejects an invalid response shape', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { unexpected: true }));
    const result = await executeWebSearchToolCall(webSearchCall('anything'), {
      ...context(fetchMock),
    });
    expect(result).toStrictEqual({ error: 'Web search returned an invalid response.', ok: false });
  });

  it('returns a tool error on network failure', async () => {
    const fetchMock = vi.fn<FetchLike>().mockRejectedValue(new Error('offline'));
    const result = await executeWebSearchToolCall(webSearchCall('anything'), {
      ...context(fetchMock),
    });
    expect(result).toStrictEqual({ error: 'Web search failed: offline', ok: false });
  });
});
