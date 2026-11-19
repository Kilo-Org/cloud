import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
  ByokPrivateProviderRequestError,
  describeByokPrivateProviderError,
  fetchByokPrivateProviderModels,
  type ByokPrivateProviderResponse,
} from './private-provider-upstream';

function failure(text: string): ByokPrivateProviderResponse {
  return { status: 401, ok: false, text };
}

describe('describeByokPrivateProviderError', () => {
  test('prefers the message of a JSON error body', () => {
    const response = failure(JSON.stringify({ error: { message: 'bad key' }, trace: 'long' }));

    expect(describeByokPrivateProviderError(response)).toBe('HTTP 401: bad key');
  });

  test('reads a string error and falls back to the text of a non-JSON body', () => {
    expect(describeByokPrivateProviderError(failure(JSON.stringify({ error: 'nope' })))).toBe(
      'HTTP 401: nope'
    );
    expect(describeByokPrivateProviderError(failure(' Unauthorized '))).toBe(
      'HTTP 401: Unauthorized'
    );
    expect(describeByokPrivateProviderError(failure(''))).toBe('HTTP 401');
  });

  test('keeps at most 300 characters of the detail', () => {
    expect(describeByokPrivateProviderError(failure('x'.repeat(1000)))).toBe(
      `HTTP 401: ${'x'.repeat(300)}`
    );
  });
});

describe('fetchByokPrivateProviderModels', () => {
  const BASE_URL = 'https://llm.example.com/v1';
  const CREDENTIALS = { type: 'api_key', api_key: 'listing-secret' } as const;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Answers each request in turn with the given page, or the given error status. */
  function mockPages(...pages: Array<unknown | Response>) {
    const urls: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      urls.push(String(input));
      const page = pages[urls.length - 1];
      return page instanceof Response ? page : Response.json(page);
    });
    return urls;
  }

  const models = (...ids: string[]) => ids.map(id => ({ id }));
  const list = () =>
    fetchByokPrivateProviderModels({ baseUrl: BASE_URL, credentials: CREDENTIALS });
  const internalIds = (result: Awaited<ReturnType<typeof list>>) =>
    result.models.map(model => model.internal_id);

  test('reads a single page that says it is the last', async () => {
    const urls = mockPages({ data: models('a', 'b'), has_more: false, last_id: 'b' });

    const result = await list();

    expect(internalIds(result)).toEqual(['a', 'b']);
    expect(result.truncated).toBe(false);
    expect(urls).toEqual([`${BASE_URL}/models`]);
  });

  test('follows Anthropic has_more and last_id with after_id', async () => {
    const urls = mockPages(
      { data: models('a', 'b'), has_more: true, last_id: 'b' },
      { data: models('c'), has_more: false, last_id: 'c' }
    );

    const result = await list();

    expect(internalIds(result)).toEqual(['a', 'b', 'c']);
    expect(result.truncated).toBe(false);
    expect(urls).toEqual([`${BASE_URL}/models`, `${BASE_URL}/models?after_id=b&limit=1000`]);
  });

  test('follows a relative or same-origin next link and merges duplicates', async () => {
    const urls = mockPages(
      { data: models('a'), next: '/v1/models?page=2' },
      { data: models('a', 'b'), links: { next: `${BASE_URL}/models?page=3` } },
      { data: models('c') }
    );

    const result = await list();

    expect(internalIds(result)).toEqual(['a', 'b', 'c']);
    expect(result.truncated).toBe(false);
    expect(urls).toEqual([
      `${BASE_URL}/models`,
      'https://llm.example.com/v1/models?page=2',
      `${BASE_URL}/models?page=3`,
    ]);
  });

  test('does not send credentials to a next link on another origin', async () => {
    const urls = mockPages({ data: models('a'), next: 'https://evil.example.net/models' });

    const result = await list();

    expect(internalIds(result)).toEqual(['a']);
    expect(result.truncated).toBe(true);
    expect(urls).toEqual([`${BASE_URL}/models`]);
  });

  test('stops after the page limit and reports the list as truncated', async () => {
    const urls = mockPages(
      ...Array.from({ length: 12 }, (_, index) => ({
        data: models(`m${index}`),
        has_more: true,
        last_id: `m${index}`,
      }))
    );

    const result = await list();

    expect(urls).toHaveLength(10);
    expect(result.models).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  test('stops on a next link that repeats a page', async () => {
    const urls = mockPages(
      { data: models('a'), next: `${BASE_URL}/models?page=2` },
      { data: models('b'), next: `${BASE_URL}/models?page=2` }
    );

    const result = await list();

    expect(urls).toHaveLength(2);
    expect(internalIds(result)).toEqual(['a', 'b']);
    expect(result.truncated).toBe(true);
  });

  test('stops at the model cap', async () => {
    const urls = mockPages(
      { data: models(...Array.from({ length: 5000 }, (_, index) => `m${index}`)), next: '/v1/x' },
      { data: models('never') }
    );

    const result = await list();

    expect(urls).toHaveLength(1);
    expect(result.models).toHaveLength(5000);
    expect(result.truncated).toBe(true);
  });

  test('keeps the models read when a later page fails', async () => {
    mockPages(
      { data: models('a'), has_more: true, last_id: 'a' },
      new Response('boom', { status: 500 })
    );

    const result = await list();

    expect(internalIds(result)).toEqual(['a']);
    expect(result.truncated).toBe(true);
  });

  test('keeps the models read when a later page is not JSON', async () => {
    mockPages({ data: models('a'), next: '/v1/models?page=2' }, new Response('<html>'));

    const result = await list();

    expect(internalIds(result)).toEqual(['a']);
    expect(result.truncated).toBe(true);
  });

  test('fails when the first page fails', async () => {
    mockPages(new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }));

    await expect(list()).rejects.toThrow(
      new ByokPrivateProviderRequestError(
        'The private provider could not list its models: HTTP 401: bad key'
      )
    );
  });

  test('reports a has_more list without a last_id as truncated', async () => {
    mockPages({ data: models('a'), has_more: true });

    const result = await list();

    expect(internalIds(result)).toEqual(['a']);
    expect(result.truncated).toBe(true);
  });
});
