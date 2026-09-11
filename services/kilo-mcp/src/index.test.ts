import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { apiHandler, clientRegistrationCallback, createMcpHandler } from './index';
import { ANONYMOUS_DISTINCT_ID, createMcpAnalytics } from './analytics';
import { ORGANIZATION_ID_HEADER } from './auth';
import type { Catalog, ForwardedAuth, GrantProps } from './types';

/** The default fetch handlers take the Worker ExecutionContext. */
const TEST_CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

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
      properties: { query: { type: 'string', minLength: 1 } },
      required: ['query'],
    },
    tags: ['clisessions'],
    searchBlob:
      'cliSessions.search Search the user CLI sessions by keyword. clisessions search query',
  },
};

/** The props-derived credentials the OAuth provider hands the API handler. */
const AUTH: ForwardedAuth = {
  authorization: 'Bearer kilo-token',
  organizationId: 'org-1',
  kiloUserId: 'user-1',
  clientId: 'client-1',
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function makeHandler(fetchImpl?: typeof fetch) {
  return createMcpHandler({
    catalog: testCatalog,
    webBaseUrl: 'https://app.kilo.ai',
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

async function rpc(
  handler: ReturnType<typeof makeHandler>,
  body: unknown,
  auth: ForwardedAuth = AUTH
): Promise<Response> {
  return handler(
    new Request('https://kilo-mcp.test/mcp', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
    auth
  );
}

async function rpcResult(body: unknown, fetchImpl?: typeof fetch, auth: ForwardedAuth = AUTH) {
  const response = await rpc(makeHandler(fetchImpl), body, auth);
  return { response, json: (await response.json()) as Record<string, unknown> };
}

describe('routing and transport', () => {
  it('answers CORS preflight with the shared header set', async () => {
    const response = await makeHandler()(
      new Request('https://kilo-mcp.test/mcp', { method: 'OPTIONS' }),
      AUTH
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Mcp-Session-Id');
  });

  it('is stateless POST-only: GET /mcp is 405', async () => {
    const response = await makeHandler()(
      new Request('https://kilo-mcp.test/mcp', { method: 'GET' }),
      AUTH
    );
    expect(response.status).toBe(405);
  });

  it('rejects a parse error and a batch request', async () => {
    const handler = makeHandler();
    const bad = await handler(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: '{not json',
      }),
      AUTH
    );
    expect(bad.status).toBe(200);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);

    const batch = await rpc(handler, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ]);
    expect(((await batch.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });

  it('answers notifications with 202 and no body', async () => {
    const response = await rpc(makeHandler(), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('rejects unknown methods with -32601', async () => {
    const { json } = await rpcResult({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
    expect((json as { error: { code: number } }).error.code).toBe(-32601);
    expect((json as { id: number }).id).toBe(7);
  });
});

describe('JSON-RPC envelope validation (zod)', () => {
  it('rejects a non-object message and a message without a method', async () => {
    const nonObject = await rpcResult('just a string');
    expect(nonObject.response.status).toBe(200);
    expect((nonObject.json as { error: { code: number } }).error.code).toBe(-32600);

    const noMethod = await rpcResult({ jsonrpc: '2.0', id: 5 });
    expect((noMethod.json as { error: { code: number } }).error.code).toBe(-32600);
    expect((noMethod.json as { id: number }).id).toBe(5);
  });

  it('rejects an empty or non-string method', async () => {
    const empty = await rpcResult({ jsonrpc: '2.0', id: 6, method: '   ' });
    expect((empty.json as { error: { code: number } }).error.code).toBe(-32600);
  });
});

describe('initialize / ping / tools/list', () => {
  it('initialize echoes the protocol version and advertises tools', async () => {
    const { json } = await rpcResult({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    });
    const result = (json as { result: Record<string, never> }).result;
    expect(result['protocolVersion']).toBe('2025-06-18');
    expect(result['serverInfo']).toMatchObject({ name: 'kilo-mcp' });
    expect(result['capabilities']).toMatchObject({ tools: {} });
  });

  it('rejects malformed initialize params with -32602', async () => {
    const { json } = await rpcResult({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: 42 },
    });
    expect((json as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('ping returns an empty result', async () => {
    const { json } = await rpcResult({ jsonrpc: '2.0', id: 3, method: 'ping' });
    expect((json as { result: unknown }).result).toEqual({});
  });

  it('tools/list returns exactly search and call, each telling the agent to search first', async () => {
    const { json } = await rpcResult({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    const tools = (
      json as {
        result: {
          tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
        };
      }
    ).result.tools;
    expect(tools.map(tool => tool.name)).toEqual(['search', 'call']);
    expect(tools[0]!.description.toLowerCase()).toContain('search');
    expect(tools[1]!.description.toLowerCase()).toContain('search');
    expect(tools[0]!.inputSchema).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
    });
    expect(tools[1]!.inputSchema).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' }, input: { type: 'object' } },
      required: ['path'],
    });
  });
});

describe('tools/call params and arguments validation (zod)', () => {
  it('rejects tools/call without a params object', async () => {
    const { json } = await rpcResult({ jsonrpc: '2.0', id: 8, method: 'tools/call' });
    expect((json as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('rejects a missing or blank tool name', async () => {
    const blank = await rpcResult({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: '   ' },
    });
    expect((blank.json as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('rejects non-object arguments at the JSON-RPC boundary', async () => {
    for (const args of [[], 5, 'nope']) {
      const { json } = await rpcResult({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'search', arguments: args },
      });
      expect((json as { error: { code: number } }).error.code).toBe(-32602);
    }
  });

  it('rejects search without a query and call without a path', async () => {
    const noQuery = await rpcResult({
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'search', arguments: {} },
    });
    expect((noQuery.json as { error: { code: number } }).error.code).toBe(-32602);

    const noPath = await rpcResult({
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/call',
      params: { name: 'call', arguments: {} },
    });
    expect((noPath.json as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('rejects a non-object call input', async () => {
    const { json } = await rpcResult({
      jsonrpc: '2.0',
      id: 25,
      method: 'tools/call',
      params: { name: 'call', arguments: { path: 'organizations.list', input: 'nope' } },
    });
    expect((json as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('unknown tool names are rejected', async () => {
    const { json } = await rpcResult({
      jsonrpc: '2.0',
      id: 26,
      method: 'tools/call',
      params: { name: 'delete', arguments: {} },
    });
    expect((json as { error: { code: number; message: string } }).error.message).toContain(
      'Unknown tool'
    );
  });
});

describe('tools/call search', () => {
  it('happy: returns catalog rows for a matching query', async () => {
    const { json } = await rpcResult({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'organizations list' } },
    });
    const content = (json as { result: { content: Array<{ type: string; text: string }> } }).result
      .content;
    const payload = JSON.parse(content[0]!.text) as {
      results: Array<{
        path: string;
        kind: string;
        summary: string;
        tags: string[];
        score: number;
      }>;
    };
    expect(payload.results[0]?.path).toBe('organizations.list');
    expect(payload.results[0]).toMatchObject({ kind: 'query', tags: ['organizations'] });
  });

  it('empty: no matches is a zero-row result with a refine-your-query message, not an error', async () => {
    const { json } = await rpcResult({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'zzqqx nothing' } },
    });
    expect('error' in (json as Record<string, unknown>)).toBe(false);
    const text = (json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    const payload = JSON.parse(text) as { results: unknown[]; message: string };
    expect(payload.results).toEqual([]);
    expect(payload.message.toLowerCase()).toContain('refine your query');
  });

  it('rejects limit values outside the published 1..50 range', async () => {
    for (const limit of [0, -1, 51, 1.5]) {
      const { json } = await rpcResult({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: 'organizations', limit } },
      });
      expect((json as { error: { code: number } }).error.code).toBe(-32602);
    }
  });

  it('accepts the boundary limits 1 and 50', async () => {
    for (const limit of [1, 50]) {
      const { json } = await rpcResult({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: 'organizations', limit } },
      });
      expect('result' in (json as Record<string, unknown>)).toBe(true);
    }
  });
});

describe('tools/call call', () => {
  it('happy: forwards the props Kilo bearer and organization header to apps/web', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { data: { balance: 42 } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const { json } = await rpcResult(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'organizations.list' } },
      },
      fetchImpl
    );
    const text = (json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    expect(text).toBe('{"balance":42}');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app.kilo.ai/api/trpc/organizations.list');
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer kilo-token');
    expect(headers[ORGANIZATION_ID_HEADER]).toBe('org-1');
  });

  it('a caller-supplied organization header never overrides the grant props', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { data: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const response = await rpc(
      makeHandler(fetchImpl),
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'organizations.list' } },
      },
      AUTH
    );
    expect(response.status).toBe(200);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)[ORGANIZATION_ID_HEADER]).toBe('org-1');
  });

  it('non-retryable: unknown path is a JSON-RPC error before any upstream request', async () => {
    const fetchImpl = vi.fn();
    const { json } = await rpcResult(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'nope.goes.here' } },
      },
      fetchImpl
    );
    expect((json as { error: { code: number } }).error.code).toBe(-32602);
    expect((json as { error: { message: string } }).error.message).toMatch(/catalog/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('non-retryable: schema-invalid input is a JSON-RPC error listing violations, no upstream', async () => {
    const fetchImpl = vi.fn();
    const { json } = await rpcResult(
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'cliSessions.search', input: { query: 12 } } },
      },
      fetchImpl
    );
    expect((json as { error: { code: number } }).error.code).toBe(-32602);
    expect((json as { error: { message: string } }).error.message).toContain('query');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retryable: an upstream tRPC error becomes a JSON-RPC error carrying code and httpStatus, and a corrected retry succeeds', async () => {
    const failing = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'You are not signed in',
              code: -32001,
              data: { code: 'UNAUTHORIZED', httpStatus: 401 },
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
    );
    const { json } = await rpcResult(
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'organizations.list' } },
      },
      failing
    );
    const error = (
      json as { error: { code: number; message: string; data: Record<string, unknown> } }
    ).error;
    expect(error.code).toBe(-32000);
    expect(error.message).toBe('You are not signed in');
    expect(error.data).toMatchObject({ trpcCode: 'UNAUTHORIZED', httpStatus: 401 });

    const retry = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { data: [{ id: 'org-1' }] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const ok = await rpcResult(
      {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'organizations.list' } },
      },
      retry
    );
    expect('result' in (ok.json as Record<string, unknown>)).toBe(true);
  });

  it('truncates results over 16 KiB with a marker and truncated metadata', async () => {
    const big = 'y'.repeat(20_000);
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { data: { blob: big } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const { json } = await rpcResult(
      {
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'organizations.list' } },
      },
      fetchImpl
    );
    const result = (json as { result: { content: Array<{ text: string }>; truncated?: boolean } })
      .result;
    expect(result.truncated).toBe(true);
    expect(result.content[0]!.text.endsWith('[truncated]')).toBe(true);
    expect(new TextEncoder().encode(result.content[0]!.text).byteLength).toBeLessThanOrEqual(
      16 * 1024
    );
  });
});

/**
 * The library transport: `@cloudflare/workers-oauth-provider` owns /mcp auth.
 * A request without a bearer never reaches the API handler.
 */
describe('OAuthProvider transport (library auth)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET /mcp with no bearer returns the library RFC 9728 challenge', async () => {
    const response = await worker.fetch(
      new Request('https://kilo-mcp.test/mcp', { method: 'GET' }),
      {} as Env,
      TEST_CTX
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="OAuth", resource_metadata="https://kilo-mcp.test/.well-known/oauth-protected-resource/mcp", scope="mcp"'
    );
  });

  it('POST /mcp with no bearer is challenged before any handler runs', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await worker.fetch(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      }),
      {} as Env,
      TEST_CTX
    );
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('OPTIONS /mcp preflight is answered by the library with CORS headers', async () => {
    const response = await worker.fetch(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'OPTIONS',
        headers: { Origin: 'https://client.test' },
      }),
      {} as Env,
      TEST_CTX
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://client.test');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});

/** The API handler: identity comes only from the decrypted grant props. */
describe('api handler (props-based auth)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function apiContext(props?: Partial<GrantProps>): {
    ctx: ExecutionContext;
    promises: Promise<unknown>[];
  } {
    const promises: Promise<unknown>[] = [];
    return {
      promises,
      ctx: {
        waitUntil: (promise: Promise<unknown>) => {
          promises.push(promise);
        },
        passThroughOnException: () => {},
        ...(props ? { props } : {}),
      } as unknown as ExecutionContext,
    };
  }

  it('forwards the grant Kilo token and organization to apps/web', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const upstream = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return Response.json({ result: { data: { ok: true } } });
    });
    vi.stubGlobal('fetch', upstream);
    const { ctx } = apiContext({
      kiloUserId: 'user-9',
      organizationId: 'org-9',
      kiloToken: 'kilo-9',
      clientId: 'client-9',
    });
    const response = await apiHandler.fetch!(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'call', arguments: { path: 'organizations.list' } },
        }),
      }),
      { WEB_BASE_URL: 'https://app.kilo.ai' } as Env,
      ctx
    );
    expect(response.status).toBe(200);
    const trpc = calls.find(call => call.url.includes('/api/trpc/'));
    expect(trpc?.headers['Authorization']).toBe('Bearer kilo-9');
    expect(trpc?.headers[ORGANIZATION_ID_HEADER]).toBe('org-9');
  });

  it('keeps the MCP CORS contract for a direct OPTIONS request', async () => {
    const { ctx } = apiContext({
      kiloUserId: 'user-1',
      organizationId: 'org-1',
      kiloToken: 'kilo-token',
      clientId: 'client-1',
    });
    const response = await apiHandler.fetch!(
      new Request('https://kilo-mcp.test/mcp', { method: 'OPTIONS' }),
      { WEB_BASE_URL: 'https://app.kilo.ai' } as Env,
      ctx
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('rejects a grant with no Kilo token bound: 401 challenge + anonymous auth_failure', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const capture = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      captured.push(
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
      );
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', capture);
    const { ctx, promises } = apiContext({
      kiloUserId: 'user-1',
      organizationId: null,
      clientId: 'c',
    });
    const response = await apiHandler.fetch!(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      }),
      {
        WEB_BASE_URL: 'https://app.kilo.ai',
        NEXT_PUBLIC_POSTHOG_KEY: 'phc_test',
      } as unknown as Env,
      ctx
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('invalid_token');
    await Promise.all(promises);

    const rejected = captured.filter(payload => payload['event'] === 'kilo_mcp_call_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!['distinct_id']).toBe(ANONYMOUS_DISTINCT_ID);
    const properties = rejected[0]!['properties'] as Record<string, unknown>;
    expect(properties).toMatchObject({ reason: 'auth_failure', $process_person_profile: false });
    expect(properties).not.toHaveProperty('userId');
  });
});

/** DCR guard: untrusted metadata is validated and out-of-scope is refused. */
describe('client registration metadata validation', () => {
  const request = new Request('https://kilo-mcp.test/register');

  it('accepts metadata with no scope and with only the mcp scope', () => {
    expect(
      clientRegistrationCallback({
        clientMetadata: { redirect_uris: ['https://client.test/cb'] },
        request,
      })
    ).toBeUndefined();
    expect(
      clientRegistrationCallback({
        clientMetadata: { redirect_uris: ['https://client.test/cb'], scope: 'mcp' },
        request,
      })
    ).toBeUndefined();
  });

  it('rejects a declared scope outside mcp instead of broadening', () => {
    const result = clientRegistrationCallback({
      clientMetadata: { redirect_uris: ['https://client.test/cb'], scope: 'mcp admin' },
      request,
    });
    expect(result).toMatchObject({ code: 'invalid_client_metadata' });
    expect(result?.description).toContain('admin');
  });

  it('rejects malformed metadata with the library invalid_client_metadata error', () => {
    const result = clientRegistrationCallback({
      clientMetadata: { redirect_uris: 'not-an-array' },
      request,
    });
    expect(result).toMatchObject({ code: 'invalid_client_metadata' });
  });
});

/**
 * s2 analytics wiring: the /mcp transport emits PostHog events through the
 * injected emitter. Captures are recorded through a fake fetch; the test awaits
 * the `waitUntil` promises before asserting.
 */
describe('analytics wiring (s2)', () => {
  type FakeCtx = { waitUntil(promise: Promise<unknown>): void };

  function createHarness(options?: {
    captureFetchImpl?: typeof fetch;
    upstreamFetchImpl?: typeof fetch;
  }) {
    const captured: Array<Record<string, unknown>> = [];
    const captureFetch = vi.fn((_url: string | URL, init?: RequestInit) => {
      const rawBody = init?.body;
      captured.push(
        JSON.parse(typeof rawBody === 'string' ? rawBody : '{}') as Record<string, unknown>
      );
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const promises: Promise<unknown>[] = [];
    const ctx: FakeCtx = {
      waitUntil: promise => {
        promises.push(promise);
      },
    };
    const analytics = createMcpAnalytics({
      env: { NEXT_PUBLIC_POSTHOG_KEY: 'phc_test' },
      ctx,
      fetchImpl: options?.captureFetchImpl ?? (captureFetch as unknown as typeof fetch),
      log: console.log,
    });
    const handler = createMcpHandler({
      catalog: testCatalog,
      webBaseUrl: 'https://app.kilo.ai',
      analytics,
      ...(options?.upstreamFetchImpl ? { fetchImpl: options.upstreamFetchImpl } : {}),
    });
    return { captured, promises, handler };
  }

  async function post(
    handler: ReturnType<typeof createMcpHandler>,
    body: unknown,
    auth: ForwardedAuth = AUTH
  ): Promise<Response> {
    return handler(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      }),
      auth
    );
  }

  async function settle(promises: Promise<unknown>[]): Promise<void> {
    await Promise.all(promises);
  }

  function eventsNamed(
    captured: Array<Record<string, unknown>>,
    event: string
  ): Array<Record<string, unknown>> {
    return captured.filter(payload => payload['event'] === event);
  }

  function propertiesOf(payload: Record<string, unknown>): Record<string, unknown> {
    return payload['properties'] as Record<string, unknown>;
  }

  it('initialize emits kilo_mcp_session_started with the negotiated version and client name', async () => {
    const { captured, promises, handler } = createHarness();
    await post(handler, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'claude-desktop' } },
    });
    await settle(promises);

    const events = eventsNamed(captured, 'kilo_mcp_session_started');
    expect(events).toHaveLength(1);
    expect(propertiesOf(events[0]!)).toMatchObject({
      feature: 'kilo-mcp',
      $lib: 'kilo-mcp-worker',
      protocolVersion: '2025-03-26',
      clientName: 'claude-desktop',
    });
  });

  it('search emits kilo_mcp_search_performed with hits, emptiness, and the query shape only', async () => {
    const { captured, promises, handler } = createHarness();
    await post(handler, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'organizations list' } },
    });
    await settle(promises);

    const events = eventsNamed(captured, 'kilo_mcp_search_performed');
    expect(events).toHaveLength(1);
    const properties = propertiesOf(events[0]!);
    expect(properties).toMatchObject({
      feature: 'kilo-mcp',
      $lib: 'kilo-mcp-worker',
      hitCount: 1,
      empty: false,
      queryTokenCount: 2,
      queryCharBucket: '17-64',
      limit: 10,
    });
    expect(JSON.stringify(properties)).not.toContain('organizations list');
    expect(eventsNamed(captured, 'kilo_mcp_tool_called')).toHaveLength(1);
  });

  it('an empty search emits empty: true and hitCount 0', async () => {
    const { captured, promises, handler } = createHarness();
    await post(handler, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'zzqqx nothing' } },
    });
    await settle(promises);

    const [event] = eventsNamed(captured, 'kilo_mcp_search_performed');
    const properties = propertiesOf(event!);
    expect(properties['empty']).toBe(true);
    expect(properties['hitCount']).toBe(0);
  });

  it('a successful call emits exactly one kilo_mcp_tool_called with the resolved path and latency', async () => {
    const upstream = vi.fn(() =>
      Promise.resolve(Response.json({ result: { data: { balance: 42 } } }))
    );
    const { captured, promises, handler } = createHarness({
      upstreamFetchImpl: upstream as unknown as typeof fetch,
    });
    const response = await post(handler, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'call', arguments: { path: 'organizations.list' } },
    });
    expect(response.status).toBe(200);
    await settle(promises);

    const events = eventsNamed(captured, 'kilo_mcp_tool_called');
    expect(events).toHaveLength(1);
    const properties = propertiesOf(events[0]!);
    expect(properties).toMatchObject({
      feature: 'kilo-mcp',
      $lib: 'kilo-mcp-worker',
      tool: 'call',
      path: 'organizations.list',
      success: true,
    });
    expect(typeof properties['latencyMs']).toBe('number');
    expect(properties['latencyMs'] as number).toBeGreaterThanOrEqual(0);
    expect(eventsNamed(captured, 'kilo_mcp_call_rejected')).toHaveLength(0);
  });

  it('an unknown path emits unknown_path on tool_called and call_rejected, and never forwards', async () => {
    const upstream = vi.fn();
    const { captured, promises, handler } = createHarness({
      upstreamFetchImpl: upstream as unknown as typeof fetch,
    });
    await post(handler, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'call', arguments: { path: 'nope.goes.here' } },
    });
    await settle(promises);

    const toolEvents = eventsNamed(captured, 'kilo_mcp_tool_called');
    expect(toolEvents).toHaveLength(1);
    expect(propertiesOf(toolEvents[0]!)).toMatchObject({
      tool: 'call',
      success: false,
      errorClass: 'unknown_path',
    });
    // The attempted path is not a catalog key, so it is never recorded.
    expect(propertiesOf(toolEvents[0]!)).not.toHaveProperty('path');

    const rejected = eventsNamed(captured, 'kilo_mcp_call_rejected');
    expect(rejected).toHaveLength(1);
    expect(propertiesOf(rejected[0]!)).toMatchObject({ reason: 'unknown_path' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('schema-invalid input emits schema_invalid with the catalog path on tool_called and call_rejected', async () => {
    const upstream = vi.fn();
    const { captured, promises, handler } = createHarness({
      upstreamFetchImpl: upstream as unknown as typeof fetch,
    });
    await post(handler, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'call', arguments: { path: 'cliSessions.search', input: { query: 12 } } },
    });
    await settle(promises);

    const toolEvents = eventsNamed(captured, 'kilo_mcp_tool_called');
    expect(toolEvents).toHaveLength(1);
    expect(propertiesOf(toolEvents[0]!)).toMatchObject({
      tool: 'call',
      path: 'cliSessions.search',
      success: false,
      errorClass: 'schema_invalid',
    });

    const rejected = eventsNamed(captured, 'kilo_mcp_call_rejected');
    expect(rejected).toHaveLength(1);
    expect(propertiesOf(rejected[0]!)).toMatchObject({
      reason: 'schema_invalid',
      path: 'cliSessions.search',
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('an unknown tool emits unknown_tool and never records the caller-supplied name', async () => {
    // `tools/call` accepts any string as `name`; a caller must not be able to
    // put arbitrary text into PostHog through it.
    const callerName = 'delete-me@example.com <script>alert(1)</script>';
    const { captured, promises, handler } = createHarness();
    await post(handler, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: callerName, arguments: {} },
    });
    await settle(promises);

    const toolEvents = eventsNamed(captured, 'kilo_mcp_tool_called');
    expect(toolEvents).toHaveLength(1);
    expect(propertiesOf(toolEvents[0]!)).toMatchObject({
      tool: 'unknown',
      success: false,
      errorClass: 'unknown_tool',
    });
    expect(JSON.stringify(toolEvents[0])).not.toContain(callerName);
    expect(propertiesOf(toolEvents[0]!)).not.toHaveProperty('path');
    expect(eventsNamed(captured, 'kilo_mcp_call_rejected')).toHaveLength(0);
  });

  it('an upstream network failure emits upstream_unreachable and is not a rejected call', async () => {
    const upstream = vi.fn(() => Promise.reject(new Error('network down')));
    const { captured, promises, handler } = createHarness({
      upstreamFetchImpl: upstream as unknown as typeof fetch,
    });
    await post(handler, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'call', arguments: { path: 'organizations.list' } },
    });
    await settle(promises);

    const toolEvents = eventsNamed(captured, 'kilo_mcp_tool_called');
    expect(toolEvents).toHaveLength(1);
    expect(propertiesOf(toolEvents[0]!)).toMatchObject({
      tool: 'call',
      path: 'organizations.list',
      success: false,
      errorClass: 'upstream_unreachable',
    });
    expect(eventsNamed(captured, 'kilo_mcp_call_rejected')).toHaveLength(0);
  });

  it('every captured payload carries no bearer or PostHog key inside its properties', async () => {
    const upstream = vi.fn(() =>
      Promise.resolve(Response.json({ result: { data: { ok: true } } }))
    );
    const { captured, promises, handler } = createHarness({
      upstreamFetchImpl: upstream as unknown as typeof fetch,
    });
    for (const body of [
      { jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: 'organizations list' } },
      },
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'organizations.list' } },
      },
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'nope.goes.here' } },
      },
      {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'cliSessions.search', input: { query: 12 } } },
      },
    ]) {
      await post(handler, body);
    }
    await settle(promises);

    expect(captured.length).toBeGreaterThan(0);
    for (const payload of captured) {
      expect(payload['api_key']).toBe('phc_test');
      expect(JSON.stringify(payload)).not.toContain('kilo-token');
      expect(JSON.stringify(propertiesOf(payload))).not.toContain('phc_');
      for (const value of Object.values(propertiesOf(payload))) {
        if (typeof value === 'string') {
          expect(value).not.toContain('organizations list');
        }
      }
    }
  });

  it('a rejecting capture transport leaves the JSON-RPC response unchanged and raises no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const rejecting = vi.fn(() => Promise.reject(new Error('capture down')));
      const { promises, handler } = createHarness({
        captureFetchImpl: rejecting as unknown as typeof fetch,
      });
      const response = await post(handler, {
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: 'organizations list' } },
      });
      expect(response.status).toBe(200);
      const json = (await response.json()) as { result: { content: Array<{ text: string }> } };
      expect(json.result.content[0]!.text).toContain('organizations.list');

      await settle(promises);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('an authenticated request binds the event to the grant user and organization', async () => {
    const upstream = vi.fn(() =>
      Promise.resolve(Response.json({ result: { data: { balance: 42 } } }))
    );
    const { captured, promises, handler } = createHarness({
      upstreamFetchImpl: upstream as unknown as typeof fetch,
    });
    const response = await post(
      handler,
      {
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'organizations.list' } },
      },
      {
        authorization: 'Bearer kilo-token',
        organizationId: 'org-1',
        kiloUserId: 'user-1',
        clientId: 'client-1',
      }
    );
    expect(response.status).toBe(200);
    await settle(promises);

    const toolEvents = eventsNamed(captured, 'kilo_mcp_tool_called');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]!['distinct_id']).toBe('user-1');
    expect(propertiesOf(toolEvents[0]!)).toMatchObject({
      userId: 'user-1',
      organizationId: 'org-1',
    });
    expect(propertiesOf(toolEvents[0]!)).not.toHaveProperty('$process_person_profile');
  });
});
