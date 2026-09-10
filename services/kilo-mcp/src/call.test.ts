import { describe, expect, it, vi } from 'vitest';
import { callCatalogEndpoint, MAX_RESULT_BYTES, serializeWithCap, TRUNCATION_MARKER } from './call';
import { JsonRpcFailure, type Catalog, type ForwardedAuth } from './types';

/** Inline test catalog (no committed fixture; tests never depend on catalog drift). */
const testCatalog: Catalog = {
  'organizations.list': {
    path: 'organizations.list',
    kind: 'query',
    summary: 'List the organizations the user belongs to.',
    inputSchema: {},
    tags: ['organizations'],
    searchBlob: 'organizations.list List the organizations the user belongs to. organizations list',
  },
  'cliSessions.search': {
    path: 'cliSessions.search',
    kind: 'query',
    summary: 'Search the user CLI sessions by keyword.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    tags: ['clisessions'],
    searchBlob:
      'cliSessions.search Search the user CLI sessions by keyword. clisessions search query limit',
  },
};

const auth: ForwardedAuth = { authorization: 'Bearer tok_123', organizationId: 'org-uuid-1' };
const WEB_BASE_URL = 'https://app.kilo.ai';

function upstreamResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('callCatalogEndpoint', () => {
  it('rejects a path outside the catalog with a JSON-RPC error and NO upstream request', async () => {
    const fetchImpl = vi.fn();
    const error = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'secrets.deleteAll',
      input: undefined,
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).code).toBe(-32602);
    expect((error as Error).message).toMatch(/catalog/);
    expect((error as Error).message).toMatch(/search/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not resolve prototype keys as catalog paths', async () => {
    const fetchImpl = vi.fn();
    await expect(
      callCatalogEndpoint({
        catalog: testCatalog,
        path: '__proto__',
        input: undefined,
        auth,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(JsonRpcFailure);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists schema violations and skips the upstream when input is invalid', async () => {
    const fetchImpl = vi.fn();
    const error = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'cliSessions.search',
      input: { query: '', limit: 999 },
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).code).toBe(-32602);
    const violations = (error as JsonRpcFailure).data?.['violations'] as string[];
    expect(violations.join('; ')).toContain('minLength');
    expect(violations.join('; ')).toContain('maximum');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a missing input for a procedure with required fields before any request', async () => {
    const fetchImpl = vi.fn();
    await expect(
      callCatalogEndpoint({
        catalog: testCatalog,
        path: 'cliSessions.search',
        input: undefined,
        auth,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl,
      })
    ).rejects.toThrow(/input is required/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards a valid call as a GET to the tRPC endpoint with auth passthrough', async () => {
    const fetchImpl = vi.fn(async () => upstreamResponse({ result: { data: { sessions: [] } } }));
    const outcome = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'cliSessions.search',
      input: { query: 'deploy' },
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    });
    expect(outcome).toEqual({ text: '{"sessions":[]}', truncated: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin).toBe(WEB_BASE_URL);
    expect(parsed.pathname).toBe('/api/trpc/cliSessions.search');
    expect(parsed.searchParams.get('input')).toBe('{"query":"deploy"}');
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok_123');
    expect(headers['x-kilocode-organizationid']).toBe('org-uuid-1');
  });

  it('omits the input param for a no-input procedure called without input', async () => {
    const fetchImpl = vi.fn(async () => upstreamResponse({ result: { data: [{ id: 'org-1' }] } }));
    const outcome = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'organizations.list',
      input: undefined,
      auth: { authorization: 'Bearer tok_123' },
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    });
    expect(outcome.text).toBe('[{"id":"org-1"}]');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.has('input')).toBe(false);
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok_123');
    expect('x-kilocode-organizationid' in headers).toBe(false);
  });

  it('maps a tRPC error body to a JSON-RPC error preserving code and httpStatus (retryable)', async () => {
    const fetchImpl = vi.fn(async () =>
      upstreamResponse(
        {
          error: {
            message: 'No such organization',
            code: -32004,
            data: { code: 'NOT_FOUND', httpStatus: 404, path: 'organizations.list' },
          },
        },
        404
      )
    );
    const error = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'organizations.list',
      input: undefined,
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).message).toBe('No such organization');
    expect((error as JsonRpcFailure).data).toMatchObject({
      trpcCode: 'NOT_FOUND',
      httpStatus: 404,
    });
    // a corrected retry succeeds
    const retryFetch = vi.fn(async () => upstreamResponse({ result: { data: [] } }));
    await expect(
      callCatalogEndpoint({
        catalog: testCatalog,
        path: 'organizations.list',
        input: undefined,
        auth,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl: retryFetch,
      })
    ).resolves.toEqual({ text: '[]', truncated: false });
  });

  it('surfaces a network failure as a retryable JSON-RPC error without leaking the token', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed: https://tok_123@secret.invalid');
    });
    const error = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'organizations.list',
      input: undefined,
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).data).toMatchObject({ retryable: true });
    expect((error as Error).message).not.toContain('tok_123');
  });

  it('rejects a 200 response without a tRPC result body', async () => {
    const fetchImpl = vi.fn(async () => upstreamResponse({ nonsense: true }));
    await expect(
      callCatalogEndpoint({
        catalog: testCatalog,
        path: 'organizations.list',
        input: undefined,
        auth,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl,
      })
    ).rejects.toThrow(/without a tRPC result body/);
  });
});

describe('serializeWithCap', () => {
  it('passes small payloads through untouched', () => {
    expect(serializeWithCap({ a: 1 })).toEqual({ text: '{"a":1}', truncated: false });
  });

  it('cuts payloads over the cap, appends the marker, and stays within 16 KiB', () => {
    const { text, truncated } = serializeWithCap({ blob: 'x'.repeat(MAX_RESULT_BYTES * 2) });
    expect(truncated).toBe(true);
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it('never splits a multi-byte code point at the cut', () => {
    const { text } = serializeWithCap({ blob: 'é'.repeat(MAX_RESULT_BYTES) });
    expect(text).not.toContain('\uFFFD');
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});
