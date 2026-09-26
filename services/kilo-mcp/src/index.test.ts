import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, {
  apiHandler,
  canUseProtectedActions,
  clientRegistrationCallback,
  createMcpHandler,
} from './index';
import { ANONYMOUS_DISTINCT_ID, createMcpAnalytics, type McpAnalytics } from './analytics';
import { ORGANIZATION_ID_HEADER } from './auth';
import type {
  Catalog,
  ForwardedAuth,
  GrantProps,
  OtpSubmitOutcome,
  ProtectedRequestsApi,
} from './types';

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
  'admin.getMetrics': {
    path: 'admin.getMetrics',
    kind: 'query',
    summary: 'Get admin-only platform metrics.',
    inputSchema: {},
    tags: ['admin'],
    searchBlob: 'admin.getMetrics Get admin-only platform metrics. admin getmetrics metrics',
    admin: true,
  },
  'debug.getState': {
    path: 'debug.getState',
    kind: 'query',
    summary: 'Read the debug platform state.',
    inputSchema: {},
    tags: ['debug'],
    searchBlob: 'debug.getState Read the debug platform state. debug getstate state',
    debug: true,
  },
  'debug.echoText': {
    path: 'debug.echoText',
    kind: 'query',
    summary: 'Echoes a short string back from the debug router.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'string',
      minLength: 2,
      maxLength: 100,
    },
    tags: ['debug'],
    searchBlob: 'debug.echoText Echoes a short string back from the debug router. debug echotext',
    debug: true,
  },
  'cliSessions.revokeAll': {
    path: 'cliSessions.revokeAll',
    kind: 'mutation',
    summary: 'Revoke every CLI session the user has.',
    inputSchema: {},
    tags: ['clisessions'],
    searchBlob: 'cliSessions.revokeAll Revoke every CLI session the user has. clisessions revoke',
  },
  'teams.create': {
    path: 'teams.create',
    kind: 'mutation',
    summary: 'Create a team in the organization.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { name: { type: 'string', minLength: 1 } },
      required: ['name'],
      additionalProperties: false,
    },
    tags: ['teams'],
    searchBlob: 'teams.create Create a team in the organization. teams create name',
  },
};

/** The props-derived credentials the OAuth provider hands the API handler. */
const AUTH: ForwardedAuth = {
  authorization: 'Bearer kilo-token',
  organizationId: 'org-1',
  kiloUserId: 'user-1',
  clientId: 'client-1',
  adminEnabled: false,
};

/**
 * The same grant, but opted into admin and debug endpoints at sign-in: enabled,
 * eligible, with the per-connection sessionId a pending request binds to.
 */
const AUTH_ADMIN: ForwardedAuth = {
  ...AUTH,
  adminEnabled: true,
  adminEligible: true,
  sessionId: 'session-1',
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** The recorded `createProtectedRequest` inputs, for assertions. */
type CreatedProtectedRequest = Parameters<ProtectedRequestsApi['createProtectedRequest']>[0];

/**
 * A fake pending-request store. `created` captures what `call_protected`
 * recorded; `peek`/`outcome` script what a `submit_otp` finds and claims.
 */
function fakeRequestsStore(options?: {
  id?: string;
  expiresAt?: string;
  peek?: 'pending' | 'gone' | { status: 'locked'; retryAfterSeconds: number };
  outcome?: OtpSubmitOutcome;
}): ProtectedRequestsApi & { created: CreatedProtectedRequest[] } {
  const created: CreatedProtectedRequest[] = [];
  return {
    created,
    async createProtectedRequest(input) {
      created.push(input);
      return {
        id: options?.id ?? 'req-1',
        expiresAt: options?.expiresAt ?? '2026-09-16T00:05:00.000Z',
      };
    },
    async peekProtectedRequest() {
      if (typeof options?.peek === 'object') return options.peek;
      return options?.peek === 'gone' ? { status: 'gone' } : { status: 'pending' };
    },
    async verifyOtpAndClaim() {
      return options?.outcome ?? { status: 'not_pending' };
    },
  };
}

/** A fetch fake whose calls a test can inspect. */
type FetchMock = typeof fetch & {
  mock: { calls: Array<[string, RequestInit | undefined]> };
};

/** A fetch fake that answers the `user.getMe` admin re-check. */
function adminCheckFetch(isAdmin: boolean): FetchMock {
  return vi.fn(async () =>
    Response.json({ result: { data: { isAdmin } } })
  ) as unknown as FetchMock;
}

/** The URLs a fetch mock was called with. */
function calledUrls(fetchImpl: FetchMock): string[] {
  return fetchImpl.mock.calls.map(call => call[0]);
}

function makeHandler(fetchImpl?: typeof fetch) {
  return createMcpHandler({
    catalog: testCatalog,
    webBaseUrl: 'https://app.kilo.ai',
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/**
 * A handler with the protected-request store (and optionally a fetch fake and a
 * catalog). Omitting `requests` is the unbound-store case.
 */
function protectedHandler(options?: {
  requests?: ProtectedRequestsApi;
  fetchImpl?: typeof fetch;
  catalog?: Catalog;
  analytics?: McpAnalytics;
}): ReturnType<typeof createMcpHandler> {
  return createMcpHandler({
    catalog: options?.catalog ?? testCatalog,
    webBaseUrl: 'https://app.kilo.ai',
    ...(options?.requests ? { protectedRequests: options.requests } : {}),
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options?.analytics ? { analytics: options.analytics } : {}),
  });
}

async function rpc(
  handler: ReturnType<typeof makeHandler>,
  body: unknown,
  auth: ForwardedAuth = AUTH,
  headers: Record<string, string> = {}
): Promise<Response> {
  return handler(
    new Request('https://kilo-mcp.test/mcp', {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...headers },
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
  it('initialize echoes the protocol version and plain instructions for a non-admin grant', async () => {
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
    // A connection without the opt-in must never see an admin or debug word.
    const instructions = result['instructions'] as string;
    expect(instructions).toContain('search (find catalog endpoints) and call (invoke one by path)');
    expect(instructions.toLowerCase()).not.toContain('admin');
    expect(instructions.toLowerCase()).not.toContain('debug');
  });

  it('initialize names call_protected and submit_otp for an opted-in admin grant', async () => {
    const response = await rpc(
      makeHandler(),
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      },
      AUTH_ADMIN
    );
    const instructions = ((await response.json()) as { result: { instructions: string } }).result
      .instructions;
    expect(instructions).toContain('call_protected');
    expect(instructions).toContain('submit_otp');
    expect(instructions).toContain('authenticator app');
    expect(instructions).toContain('fixed once call_protected returns');
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
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    // The input value's shape belongs to the endpoint's published schema, so
    // the tool must not constrain it to an object: debug.badInputError takes a
    // string, and a record-only argument left that row uncallable.
    const inputProperty = (
      tools[1]!.inputSchema.properties as Record<string, Record<string, unknown>>
    ).input;
    expect(inputProperty).toBeDefined();
    expect(inputProperty).not.toHaveProperty('type');
  });

  it('tools/list adds call_protected and submit_otp only for an opted-in admin grant', async () => {
    const response = await rpc(
      makeHandler(),
      { jsonrpc: '2.0', id: 5, method: 'tools/list' },
      AUTH_ADMIN
    );
    const tools = (
      (await response.json()) as {
        result: {
          tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
        };
      }
    ).result.tools;
    expect(tools.map(tool => tool.name)).toEqual([
      'search',
      'call',
      'call_protected',
      'submit_otp',
    ]);
    const callProtected = tools[2]!;
    expect(callProtected.description).toContain('authenticator app');
    expect(callProtected.description).toContain('fixed once this returns');
    expect(callProtected.inputSchema).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    const submitOtp = tools[3]!;
    expect(submitOtp.description).toContain('authenticator app');
    expect(submitOtp.description).toContain('cannot change here');
    expect(submitOtp.inputSchema).toMatchObject({
      type: 'object',
      properties: { request_id: { type: 'string' }, otp: { type: 'string' } },
      required: ['request_id', 'otp'],
    });
  });

  it('tools/list gates on the sessionId: an opted-in grant without one sees only search and call', async () => {
    for (const auth of [
      { ...AUTH, adminEnabled: true, adminEligible: true },
      { ...AUTH_ADMIN, sessionId: '' },
      { ...AUTH_ADMIN, adminEligible: false },
      { ...AUTH_ADMIN, adminEnabled: false },
    ]) {
      const response = await rpc(
        makeHandler(),
        { jsonrpc: '2.0', id: 6, method: 'tools/list' },
        auth
      );
      const tools = ((await response.json()) as { result: { tools: Array<{ name: string }> } })
        .result.tools;
      expect(tools.map(tool => tool.name)).toEqual(['search', 'call']);
    }
    expect(canUseProtectedActions(AUTH_ADMIN)).toBe(true);
    expect(canUseProtectedActions(AUTH)).toBe(false);
  });

  it('a connection without the opt-in cannot discover or call the protected tools', async () => {
    // Every other connection gets the ordinary unknown-tool answer for either
    // name — the tools are unlisted and unreachable, so neither can leak.
    for (const auth of [AUTH, { ...AUTH, adminEnabled: true, adminEligible: true }]) {
      for (const name of ['call_protected', 'submit_otp']) {
        const { json } = await rpcResult(
          {
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name, arguments: {} },
          },
          undefined,
          auth
        );
        expect((json as { error: { code: number; message: string } }).error.code).toBe(-32602);
        expect((json as { error: { code: number; message: string } }).error.message).toBe(
          `Unknown tool "${name}". Available tools: search, call.`
        );
      }
    }
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

  it('call accepts the scalar input a published schema describes and forwards exactly it', async () => {
    // A published schema may describe a scalar (not an object); the tool
    // argument must accept it instead of demanding an object, or the row can
    // never be called at all.
    const scalarCatalog: Catalog = {
      'reports.echo': {
        path: 'reports.echo',
        kind: 'query',
        summary: 'Echoes a short string back.',
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'string',
          minLength: 2,
          maxLength: 100,
        },
        tags: ['reports'],
        searchBlob: 'reports.echo Echoes a short string back. reports echo',
      },
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { data: 'you sent: hello' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const response = await rpc(
      protectedHandler({ catalog: scalarCatalog, fetchImpl }),
      {
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'reports.echo', input: 'hello' } },
      },
      AUTH
    );
    const json = (await response.json()) as { result: { content: Array<{ text: string }> } };
    expect(json.result.content[0]!.text).toBe('"you sent: hello"');
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://app.kilo.ai/api/trpc/reports.echo?input=%22hello%22');
  });

  it('call_protected accepts the scalar input a published schema describes and records exactly it', async () => {
    const fetchImpl = vi.fn();
    const requests = fakeRequestsStore({ id: 'req-scalar' });
    const response = await rpc(
      protectedHandler({ requests, fetchImpl }),
      {
        jsonrpc: '2.0',
        id: 26,
        method: 'tools/call',
        params: { name: 'call_protected', arguments: { path: 'debug.echoText', input: 'hello' } },
      },
      AUTH_ADMIN
    );
    const json = (await response.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(json.result.content[0]!.text)).toMatchObject({
      status: 'otp_required',
      request_id: 'req-scalar',
    });
    expect(requests.created[0]).toMatchObject({
      path: 'debug.echoText',
      kind: 'debug',
      inputJson: '"hello"',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('unknown tool names are rejected', async () => {
    const { json } = await rpcResult({
      jsonrpc: '2.0',
      id: 27,
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

  it('happy: returns the published mutation with kind: "mutation" and the schema call applies', async () => {
    const { json } = await rpcResult({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'create a team' } },
    });
    const content = (json as { result: { content: Array<{ text: string }> } }).result.content;
    const payload = JSON.parse(content[0]!.text) as {
      results: Array<{ path: string; kind: string; inputSchema: Record<string, unknown> }>;
    };
    const hit = payload.results[0]!;
    expect(hit).toMatchObject({ path: 'teams.create', kind: 'mutation' });
    // The tool description promises the input schema; the row must carry the
    // exact published schema, naming the property the agent has to send.
    expect(hit.inputSchema).toEqual(testCatalog['teams.create']!.inputSchema);
    expect(hit.inputSchema).toMatchObject({
      properties: { name: { type: 'string', minLength: 1 } },
      required: ['name'],
    });

    // The schema the search returned is what `call` accepts: build the input
    // from its required property list and confirm the call goes through.
    const required = hit.inputSchema['required'] as string[];
    const input = { [required[0]!]: 'core' };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { data: { id: 'team-1' } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const called = await rpcResult(
      {
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: hit.path, input } },
      },
      fetchImpl
    );
    expect('error' in called.json).toBe(false);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app.kilo.ai/api/trpc/teams.create');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"core"}');
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
    expect(payload.message).toContain('zzqqx nothing');
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

  it('omits admin rows for a grant without the admin opt-in and returns them when it opted in', async () => {
    const body = {
      jsonrpc: '2.0',
      id: 27,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'metrics' } },
    };
    const disabled = await rpcResult(body, undefined, AUTH);
    const disabledText = (disabled.json as { result: { content: Array<{ text: string }> } }).result
      .content[0]!.text;
    expect(disabledText).not.toContain('admin.getMetrics');

    const enabled = await rpcResult(body, undefined, AUTH_ADMIN);
    const enabledText = (enabled.json as { result: { content: Array<{ text: string }> } }).result
      .content[0]!.text;
    expect(enabledText).toContain('admin.getMetrics');
  });

  it('empty: names the hidden admin and debug endpoints for an admin-eligible grant that did not opt in', async () => {
    const hiddenMessage = async (query: string): Promise<string> => {
      const { json } = await rpcResult(
        {
          jsonrpc: '2.0',
          id: 30,
          method: 'tools/call',
          params: { name: 'search', arguments: { query } },
        },
        undefined,
        { ...AUTH, adminEligible: true }
      );
      return (json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    };
    for (const query of ['metrics', 'debug']) {
      const text = await hiddenMessage(query);
      const payload = JSON.parse(text) as { results: unknown[]; message: string };
      // The catalog does match; the rows are hidden, so the shape stays a
      // zero-row result and the message names both hidden families and the
      // checkbox to tick, with no approval-queue reference.
      expect(payload.results).toEqual([]);
      expect(payload.message).toContain(`No endpoints matched "${query}"`);
      expect(payload.message).toContain(
        'admin or debug endpoints and are hidden for this connection'
      );
      expect(payload.message).toContain('Enable admin and debug actions');
      expect(payload.message).toContain('code from your authenticator app');
      expect(payload.message).not.toContain('queue');
    }
  });

  it('empty: a non-admin or pre-feature grant gets the plain message with no admin or debug trace', async () => {
    const hiddenMessage = async (auth: ForwardedAuth, query: string): Promise<string> => {
      const { json } = await rpcResult(
        {
          jsonrpc: '2.0',
          id: 31,
          method: 'tools/call',
          params: { name: 'search', arguments: { query } },
        },
        undefined,
        auth
      );
      return (json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    };
    // AUTH carries no adminEligible key (a pre-feature grant) and the explicit
    // false both stay non-eligible: no hidden-endpoint sentence, no queue URL.
    for (const auth of [AUTH, { ...AUTH, adminEligible: false }]) {
      for (const query of ['metrics', 'debug', 'zzqqx nothing']) {
        const text = await hiddenMessage(auth, query);
        expect(text).toContain('No endpoints matched');
        expect(text).not.toContain('hidden for this connection');
        expect(text).not.toContain('queue');
      }
    }
  });

  it('returns guarded hits marked requiresApproval with no hint when the grant opted in', async () => {
    const search = async (
      query: string
    ): Promise<{ text: string; results: Array<Record<string, unknown>> }> => {
      const { json } = await rpcResult(
        {
          jsonrpc: '2.0',
          id: 33,
          method: 'tools/call',
          params: { name: 'search', arguments: { query } },
        },
        undefined,
        AUTH_ADMIN
      );
      const text = (json as { result: { content: Array<{ text: string }> } }).result.content[0]!
        .text;
      return {
        text,
        results: (JSON.parse(text) as { results: Array<Record<string, unknown>> }).results,
      };
    };
    const admin = await search('metrics');
    expect(admin.results).toContainEqual(
      expect.objectContaining({ path: 'admin.getMetrics', requiresApproval: true })
    );
    expect(admin.text).not.toContain('hidden for this connection');

    const debug = await search('debug');
    expect(debug.results).toContainEqual(
      expect.objectContaining({ path: 'debug.getState', requiresApproval: true })
    );
  });

  it('runs the semantic hook once for an empty search on a grant without the admin opt-in', async () => {
    const semanticCandidates = vi.fn(async () => []);
    const handler = createMcpHandler({
      catalog: testCatalog,
      webBaseUrl: 'https://app.kilo.ai',
      semanticCandidates,
    });
    const response = await rpc(
      handler,
      {
        jsonrpc: '2.0',
        id: 34,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: 'metrics' } },
      },
      AUTH
    );
    expect(response.status).toBe(200);
    // The embedding + Vectorize lookup happen once for the whole search, even
    // though the admin gate hides the query's only match.
    expect(semanticCandidates).toHaveBeenCalledTimes(1);
  });

  it('keeps an over-cap search payload parseable JSON instead of cutting it mid-token', async () => {
    // Every hit now carries its full input schema, so a result set can exceed
    // the cap the call tool already enforces. A lone hit whose schema alone
    // passes the cap must still yield valid JSON: the hit is dropped and the
    // payload says so, never left as text cut at a byte boundary.
    const big = 'z'.repeat(20_000);
    const blobCatalog: Catalog = {
      'blob.get': {
        path: 'blob.get',
        kind: 'query',
        summary: 'Get the stored blob.',
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { blob: { type: 'string', examples: [big] } },
        },
        tags: ['blob'],
        searchBlob: 'blob.get Get the stored blob. blob get',
      },
    };
    const response = await rpc(
      createMcpHandler({ catalog: blobCatalog, webBaseUrl: 'https://app.kilo.ai' }),
      {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: 'stored blob' } },
      }
    );
    const result = (
      (await response.json()) as {
        result: { content: Array<{ text: string }>; truncated?: boolean };
      }
    ).result;
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.content[0]!.text).byteLength).toBeLessThanOrEqual(
      16 * 1024
    );
    // Parseable, unlike a payload cut at a byte boundary.
    const payload = JSON.parse(result.content[0]!.text) as {
      results: Array<{ path: string }>;
      truncated: boolean;
      message: string;
    };
    expect(payload.truncated).toBe(true);
    expect(payload.results).toEqual([]);
    expect(payload.message).toContain('Dropped 1 of 1');
  });

  it('drops only the lowest-ranked hits when part of the results fit', async () => {
    // Three equally scored hits (ties break by path ascending) of ~6 KB each:
    // the top two fit under the cap, the third does not, so the payload must
    // keep blob.alpha and blob.beta and report the one dropped.
    const filler = 'z'.repeat(6_000);
    const row = (path: string): Catalog[string] => ({
      path,
      kind: 'query',
      summary: 'Get the stored blob.',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { blob: { type: 'string', examples: [filler] } },
      },
      tags: ['blob'],
      searchBlob: `${path} Get the stored blob. stored blob`,
    });
    const catalog: Catalog = {
      'blob.alpha': row('blob.alpha'),
      'blob.beta': row('blob.beta'),
      'blob.gamma': row('blob.gamma'),
    };
    const response = await rpc(createMcpHandler({ catalog, webBaseUrl: 'https://app.kilo.ai' }), {
      jsonrpc: '2.0',
      id: 25,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'stored blob' } },
    });
    const result = (
      (await response.json()) as {
        result: { content: Array<{ text: string }>; truncated?: boolean };
      }
    ).result;
    expect(result.truncated).toBe(true);
    const text = result.content[0]!.text;
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(16 * 1024);
    const payload = JSON.parse(text) as {
      results: Array<{ path: string; inputSchema: Record<string, unknown> }>;
      truncated: boolean;
      message: string;
    };
    expect(payload.results.map(hit => hit.path)).toEqual(['blob.alpha', 'blob.beta']);
    // Kept hits are whole rows, schema included.
    expect(payload.results[1]!.inputSchema).toEqual(catalog['blob.beta']!.inputSchema);
    expect(payload.message).toContain('Dropped 1 of 3');
  });

  it('keeps the empty-results payload parseable for an oversized query', async () => {
    // The empty state echoes the query back, and the query has no length bound.
    // The echo is bounded before JSON.stringify, so the payload stays valid JSON
    // under the cap instead of being cut mid-token by the generic cap.
    const { json } = await rpcResult({
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'z'.repeat(20_000) } },
    });
    const result = (json as { result: { content: Array<{ text: string }>; truncated?: boolean } })
      .result;
    expect(result.truncated).toBeUndefined();
    expect(new TextEncoder().encode(result.content[0]!.text).byteLength).toBeLessThanOrEqual(
      16 * 1024
    );
    // Parseable, unlike a payload cut at a byte boundary.
    const payload = JSON.parse(result.content[0]!.text) as { results: unknown[]; message: string };
    expect(payload.results).toEqual([]);
    expect(payload.message).toContain('No endpoints matched');
    expect(payload.message.toLowerCase()).toContain('refine your query');
    // The echo is bounded, so an unbounded query is never printed in full.
    expect(payload.message).not.toContain('z'.repeat(1_000));
  });

  it('does not mark a small search payload truncated', async () => {
    const { json } = await rpcResult({
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'organizations list' } },
    });
    const result = (json as { result: { content: Array<{ text: string }>; truncated?: boolean } })
      .result;
    expect(result.truncated).toBeUndefined();
    // The payload stays parseable JSON, so the agent can build the call.
    const payload = JSON.parse(result.content[0]!.text) as { results: unknown[] };
    expect(payload.results.length).toBeGreaterThan(0);
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

  it('happy: applies a mutation with one POST upstream and returns the upstream data', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { data: { id: 'team-1' } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const { json } = await rpcResult(
      {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'teams.create', input: { name: 'core' } } },
      },
      fetchImpl
    );
    const text = (json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    expect(text).toBe('{"id":"team-1"}');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app.kilo.ai/api/trpc/teams.create');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"name":"core"}');
  });

  it('happy: a void mutation ({"result":{}}) is a success, not an error', async () => {
    // A void procedure (the real agentProfiles.bindToRepo/unbindRepo) serializes
    // to `{"result":{}}`; reporting an error would tell the agent the write
    // failed when it landed.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const { json } = await rpcResult(
      {
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'cliSessions.revokeAll' } },
      },
      fetchImpl
    );
    expect((json as { error?: unknown }).error).toBeUndefined();
    const text = (json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    expect(text).toBe('null');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app.kilo.ai/api/trpc/cliSessions.revokeAll');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
  });

  it('a query path still goes out as GET with no body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { data: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    await rpcResult(
      {
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'organizations.list' } },
      },
      fetchImpl
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('non-retryable: schema-invalid mutation input lists violations with no upstream request', async () => {
    const fetchImpl = vi.fn();
    const { json } = await rpcResult(
      {
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'teams.create', input: { name: '' } } },
      },
      fetchImpl
    );
    const error = (json as { error: { code: number; message: string } }).error;
    expect(error.code).toBe(-32602);
    expect(error.message).toContain('name');
    expect(error.message).toContain('minLength');
    expect(error.message).not.toContain('may or may not');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('non-retryable: a mutation path absent from the catalog is Unknown path with no upstream request', async () => {
    const fetchImpl = vi.fn();
    const { json } = await rpcResult(
      {
        jsonrpc: '2.0',
        id: 33,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'teams.delete' } },
      },
      fetchImpl
    );
    const error = (json as { error: { code: number; message: string } }).error;
    expect(error.code).toBe(-32602);
    expect(error.message).toContain('Unknown path');
    expect(error.message).not.toContain('may or may not');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a caller-supplied organization header never overrides the grant props', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { data: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const handler = vi.fn(makeHandler(fetchImpl));
    const response = await rpc(
      handler,
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'organizations.list' } },
      },
      AUTH,
      { [ORGANIZATION_ID_HEADER]: 'org-attacker', Authorization: 'Bearer caller-mcp-token' }
    );
    expect(response.status).toBe(200);
    expect(handler.mock.calls[0]?.[0].headers.get(ORGANIZATION_ID_HEADER)).toBe('org-attacker');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)[ORGANIZATION_ID_HEADER]).toBe('org-1');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer kilo-token');
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

  it('non-retryable: a guarded path is refused locally for a grant that did not opt in, no upstream', async () => {
    const fetchImpl = vi.fn();
    for (const path of ['admin.getMetrics', 'debug.getState']) {
      const { json } = await rpcResult(
        {
          jsonrpc: '2.0',
          id: 28,
          method: 'tools/call',
          params: { name: 'call', arguments: { path } },
        },
        fetchImpl
      );
      const error = (json as { error: { code: number; message: string } }).error;
      expect(error.code).toBe(-32602);
      expect(error.message).toBe(
        `"${path}" is an admin or debug endpoint. Reconnect the Kilo MCP server and tick "Enable admin and debug actions" at sign-in to allow admin and debug actions.`
      );
      expect(error.message).not.toContain('queue');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('non-retryable: an opted-in grant is refused by call too, pointing at call_protected, no upstream', async () => {
    const fetchImpl = vi.fn();
    for (const path of ['admin.getMetrics', 'debug.getState']) {
      const response = await rpc(
        makeHandler(fetchImpl),
        {
          jsonrpc: '2.0',
          id: 28,
          method: 'tools/call',
          params: { name: 'call', arguments: { path } },
        },
        AUTH_ADMIN
      );
      const error = ((await response.json()) as { error: { code: number; message: string } }).error;
      expect(error.code).toBe(-32602);
      expect(error.message).toBe(
        `"${path}" is an admin or debug endpoint. Use the call_protected tool, then submit_otp with the code from your authenticator app, to run it.`
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('call_protected refuses an unknown path, an unguarded row and a schema-invalid input locally', async () => {
    const fetchImpl = vi.fn();
    const requests = fakeRequestsStore();
    const handler = protectedHandler({ requests, fetchImpl });
    const refusal = async (
      path: string,
      input?: unknown
    ): Promise<{ code: number; message: string }> => {
      const response = await rpc(
        handler,
        {
          jsonrpc: '2.0',
          id: 29,
          method: 'tools/call',
          params: {
            name: 'call_protected',
            arguments: input === undefined ? { path } : { path, input },
          },
        },
        AUTH_ADMIN
      );
      return ((await response.json()) as { error: { code: number; message: string } }).error;
    };

    const unknown = await refusal('nope.goes.here');
    expect(unknown.code).toBe(-32602);
    expect(unknown.message).toMatch(/Unknown path/);

    const unguarded = await refusal('organizations.list');
    expect(unguarded.code).toBe(-32602);
    expect(unguarded.message).toBe(
      '"organizations.list" is not an admin or debug endpoint. Use the call tool for it.'
    );

    const invalid = await refusal('debug.echoText', 5);
    expect(invalid.code).toBe(-32602);
    expect(invalid.message).toContain('does not match the published schema');

    expect(requests.created).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('call_protected records an admin call and returns otp_required with zero fetches', async () => {
    const fetchImpl = vi.fn();
    const requests = fakeRequestsStore({
      id: 'req-42',
      expiresAt: '2026-09-16T00:05:00.000Z',
    });
    const response = await rpc(
      protectedHandler({ requests, fetchImpl }),
      {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'call_protected', arguments: { path: 'admin.getMetrics' } },
      },
      AUTH_ADMIN
    );
    const text = ((await response.json()) as { result: { content: Array<{ text: string }> } })
      .result.content[0]!.text;
    expect(JSON.parse(text)).toEqual({
      status: 'otp_required',
      request_id: 'req-42',
      expires_at: '2026-09-16T00:05:00.000Z',
      message:
        'Approval required: ask the user to read the current code from their authenticator app, then call submit_otp with this request_id and that code. The request expires at 2026-09-16T00:05:00.000Z.',
    });
    expect(requests.created[0]).toMatchObject({
      sessionId: 'session-1',
      path: 'admin.getMetrics',
      kind: 'admin',
      inputJson: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('call_protected records a debug call as kind debug with the reviewed input and no upstream', async () => {
    const fetchImpl = vi.fn();
    const requests = fakeRequestsStore({ id: 'req-dbg' });
    const response = await rpc(
      protectedHandler({ requests, fetchImpl }),
      {
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: { name: 'call_protected', arguments: { path: 'debug.getState' } },
      },
      AUTH_ADMIN
    );
    const text = ((await response.json()) as { result: { content: Array<{ text: string }> } })
      .result.content[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ status: 'otp_required', request_id: 'req-dbg' });
    expect(requests.created[0]).toMatchObject({
      path: 'debug.getState',
      kind: 'debug',
      inputJson: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('non-retryable: an opted-in guarded call without the request store never fails open', async () => {
    const fetchImpl = vi.fn();
    const response = await rpc(
      protectedHandler({ fetchImpl }),
      {
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: { name: 'call_protected', arguments: { path: 'admin.getMetrics' } },
      },
      AUTH_ADMIN
    );
    const json = (await response.json()) as { error: { code: number; data: unknown } };
    expect(json.error.code).toBe(-32000);
    expect(json.error.data).toMatchObject({ path: 'admin.getMetrics', retryable: true });
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

describe('tools/call submit_otp', () => {
  async function submit(
    handler: ReturnType<typeof createMcpHandler>,
    args: Record<string, unknown>,
    auth: ForwardedAuth = AUTH_ADMIN
  ): Promise<{ response: Response; json: Record<string, unknown> }> {
    const response = await rpc(
      handler,
      {
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: { name: 'submit_otp', arguments: args },
      },
      auth
    );
    return { response, json: (await response.json()) as Record<string, unknown> };
  }

  it('maps every OtpSubmitOutcome to its own refusal copy', async () => {
    const cases: Array<[OtpSubmitOutcome, string]> = [
      [
        { status: 'not_pending' },
        'This request is no longer pending. Start a new admin or debug call with call_protected.',
      ],
      [
        { status: 'expired' },
        'This request expired. Start a new admin or debug call with call_protected.',
      ],
      [
        { status: 'invalidated' },
        'This request was cancelled after too many incorrect codes. Start a new admin or debug call with call_protected.',
      ],
      [
        { status: 'bad_code', attemptsRemaining: 4 },
        'That code is not valid. Check your authenticator app and try again. 4 attempts remaining.',
      ],
      [
        { status: 'reused_code' },
        'That code was already used. Ask the user for the next code from their authenticator app, then submit it again.',
      ],
      [
        { status: 'no_authenticator' },
        'No authenticator is registered for this Kilo account. Reconnect the Kilo MCP server and add your authenticator at sign-in.',
      ],
      [
        { status: 'locked', retryAfterSeconds: 900 },
        'Too many incorrect codes were submitted for this Kilo account. Try again in 15 minutes, then start a new admin or debug call with call_protected.',
      ],
      [
        { status: 'locked', retryAfterSeconds: 20 },
        'Too many incorrect codes were submitted for this Kilo account. Try again in 1 minute, then start a new admin or debug call with call_protected.',
      ],
    ];
    for (const [outcome, message] of cases) {
      const requests = fakeRequestsStore({ outcome });
      const fetchImpl = adminCheckFetch(true);
      const { json } = await submit(protectedHandler({ requests, fetchImpl }), {
        request_id: 'req-1',
        otp: '123456',
      });
      const error = json['error'] as { code: number; message: string };
      expect(error.code).toBe(-32602);
      expect(error.message).toBe(message);
      // The wrong-code refusal states the attempts without the code.
      expect(JSON.stringify(json)).not.toContain('123456');
      // No outcome other than `ok` runs the recorded call.
      expect(calledUrls(fetchImpl).filter(url => url.includes('/api/trpc/debug'))).toHaveLength(0);
      expect(calledUrls(fetchImpl).filter(url => url.includes('/api/trpc/admin'))).toHaveLength(0);
    }
  });

  it('answers the uniform no-longer-pending refusal for a gone request and checks nothing else', async () => {
    const requests = fakeRequestsStore({ peek: 'gone' });
    const fetchImpl = adminCheckFetch(true);
    const { json } = await submit(protectedHandler({ requests, fetchImpl }), {
      request_id: 'never-issued',
      otp: '123456',
    });
    expect((json['error'] as { message: string }).message).toBe(
      'This request is no longer pending. Start a new admin or debug call with call_protected.'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a locked account before spending an upstream admin re-check', async () => {
    const requests = fakeRequestsStore({
      peek: { status: 'locked', retryAfterSeconds: 900 },
    });
    const fetchImpl = adminCheckFetch(true);
    const { json } = await submit(protectedHandler({ requests, fetchImpl }), {
      request_id: 'req-1',
      otp: '123456',
    });
    const error = json['error'] as { code: number; message: string };
    expect(error.code).toBe(-32602);
    expect(error.message).toBe(
      'Too many incorrect codes were submitted for this Kilo account. Try again in 15 minutes, then start a new admin or debug call with call_protected.'
    );
    // The account-wide lock is consulted at peek, before the live admin check,
    // so a locked account spends no upstream request on a guess.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('non-retryable: an admin who lost the role cannot run an already-pending request', async () => {
    const requests = fakeRequestsStore({
      outcome: { status: 'ok', path: 'admin.getMetrics', inputJson: null },
    });
    const fetchImpl = adminCheckFetch(false);
    const { json } = await submit(protectedHandler({ requests, fetchImpl }), {
      request_id: 'req-1',
      otp: '123456',
    });
    const error = json['error'] as { code: number; message: string };
    expect(error.code).toBe(-32602);
    expect(error.message).toBe(
      'Your Kilo account does not have admin access, so this admin or debug call cannot run. Reconnect the Kilo MCP server if that is unexpected.'
    );
    expect(calledUrls(fetchImpl).filter(url => url.includes('/api/trpc/admin'))).toHaveLength(0);
  });

  it('retryable: a thrown admin check refuses without running the call', async () => {
    const requests = fakeRequestsStore({
      outcome: { status: 'ok', path: 'admin.getMetrics', inputJson: null },
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error('user.getMe upstream unreachable');
    }) as unknown as FetchMock;
    const { json } = await submit(protectedHandler({ requests, fetchImpl }), {
      request_id: 'req-1',
      otp: '123456',
    });
    const error = json['error'] as { code: number; message: string };
    expect(error.code).toBe(-32000);
    expect(error.message).toBe(
      'Could not check admin access for this admin or debug call. Retry; if it keeps failing, reconnect the Kilo MCP server.'
    );
    expect(calledUrls(fetchImpl).filter(url => url.includes('/api/trpc/admin'))).toHaveLength(0);
  });

  it('fails closed when the pending-request store is missing', async () => {
    const fetchImpl = adminCheckFetch(true);
    const { json } = await submit(protectedHandler({ fetchImpl }), {
      request_id: 'req-1',
      otp: '123456',
    });
    const error = json['error'] as { code: number; data: unknown };
    expect(error.code).toBe(-32000);
    expect(error.data).toMatchObject({ retryable: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a submit that tries to change the reviewed payload', async () => {
    for (const args of [
      { request_id: 'req-1', otp: '123456', path: 'admin.getMetrics' },
      { request_id: 'req-1', otp: '123456', input: { verbose: true } },
    ]) {
      const { json } = await submit(protectedHandler({ requests: fakeRequestsStore() }), args);
      const error = json['error'] as { code: number; message: string };
      expect(error.code).toBe(-32602);
      expect(error.message).toContain('Invalid submit_otp arguments');
    }
  });

  it('on ok runs the recorded path exactly once and returns the upstream result', async () => {
    const requests = fakeRequestsStore({
      outcome: { status: 'ok', path: 'debug.getState', inputJson: null },
    });
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (String(input).includes('/api/trpc/user.getMe')) {
        return Response.json({ result: { data: { isAdmin: true } } });
      }
      return Response.json({ result: { data: { ok: true } } });
    }) as unknown as FetchMock;
    const { json } = await submit(protectedHandler({ requests, fetchImpl }), {
      request_id: 'req-1',
      otp: '123456',
    });
    const text = (json['result'] as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toBe('{"ok":true}');

    const urls = calledUrls(fetchImpl);
    expect(urls.filter(url => url.includes('/api/trpc/debug.getState'))).toHaveLength(1);
    expect(urls.filter(url => url.includes('/api/trpc/user.getMe'))).toHaveLength(1);
    // The admin re-check forwards the grant's Kilo bearer exactly once.
    const meCall = fetchImpl.mock.calls.find(call => call[0].includes('user.getMe'));
    const meHeaders = (meCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(meHeaders['Authorization']).toBe('Bearer kilo-token');
  });

  it('never puts the submitted code in a response body, an analytics event or a log line', async () => {
    const code = '919191';
    const events: unknown[] = [];
    const analytics: McpAnalytics = {
      sessionStarted: () => {},
      toolCalled: input => {
        events.push(input);
      },
      searchPerformed: () => {},
      callRejected: input => {
        events.push(input);
      },
      oauthSignIn: () => {},
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const requests = fakeRequestsStore({ outcome: { status: 'bad_code', attemptsRemaining: 4 } });
      const { json } = await submit(
        protectedHandler({ requests, fetchImpl: adminCheckFetch(true), analytics }),
        { request_id: 'req-1', otp: code }
      );
      expect(JSON.stringify(json)).not.toContain(code);
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain(code);
      for (const spy of [log, errorLog]) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(code);
        }
      }
    } finally {
      log.mockRestore();
      errorLog.mockRestore();
    }
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

  it.each([false, true])(
    'emits anonymous OAuth error analytics without changing the response (capture fails: %s)',
    async captureFails => {
      const captures: Record<string, unknown>[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL, init: RequestInit = {}) => {
          // The provider resolves the bearer as a Kilo session token via
          // apps/web first; a 401 keeps it an invalid token without a capture.
          if (String(input).includes('/api/user')) return new Response(null, { status: 401 });
          captures.push(
            JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>
          );
          if (captureFails) throw new Error('capture unavailable');
          return Response.json({});
        })
      );
      const promises: Promise<unknown>[] = [];
      const response = await worker.fetch(
        new Request('https://kilo-mcp.test/mcp', { headers: { Authorization: 'Bearer forged' } }),
        {
          NEXT_PUBLIC_POSTHOG_KEY: 'phc_test',
          OAUTH_KV: { get: async () => null },
        } as unknown as Env,
        { ...TEST_CTX, waitUntil: promise => promises.push(promise) }
      );
      expect(response.status).toBe(401);
      await Promise.all(promises);
      expect(captures).toHaveLength(1);
      expect(captures[0]).toMatchObject({
        event: 'kilo_mcp_oauth_sign_in_failed',
        distinct_id: ANONYMOUS_DISTINCT_ID,
        properties: { phase: 'failed', reason: 'invalid_token', $process_person_profile: false },
      });
      expect(JSON.stringify(captures)).not.toContain('forged');
    }
  );

  it('keeps concurrent provider errors bound to their own request analytics', async () => {
    const captures: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        if (String(input).includes('/api/user')) return new Response(null, { status: 401 });
        captures.push(
          JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>
        );
        return Response.json({});
      })
    );
    const pending = [[], []] as Promise<unknown>[][];
    await Promise.all(
      pending.map(async (promises, index) => {
        const response = await worker.fetch(
          new Request('https://kilo-mcp.test/mcp', { headers: { Authorization: 'Bearer forged' } }),
          {
            NEXT_PUBLIC_POSTHOG_KEY: `phc_request_${index}`,
            OAUTH_KV: { get: async () => null },
          } as unknown as Env,
          { ...TEST_CTX, waitUntil: promise => promises.push(promise) }
        );
        expect(response.status).toBe(401);
        expect(promises).toHaveLength(1);
        await Promise.all(promises);
      })
    );
    expect(captures.map(capture => capture['api_key']).sort()).toEqual([
      'phc_request_0',
      'phc_request_1',
    ]);
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

  it('accepts the signed-in app session token as the MCP credential', async () => {
    const upstream = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      if (String(input).includes('/api/user')) return Response.json({ id: 'user-session' });
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', upstream);
    const response = await worker.fetch(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers: { ...JSON_HEADERS, Authorization: 'Bearer kilo-session-token' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      {
        WEB_BASE_URL: 'https://app.kilo.ai',
        OAUTH_KV: { get: async () => null },
      } as unknown as Env,
      { ...TEST_CTX }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(json.result.tools.map(tool => tool.name)).toEqual(['search', 'call']);

    // apps/web is the trust anchor: the verification request carried the bearer.
    const verification = upstream.mock.calls.find(call => String(call[0]).includes('/api/user'));
    expect(verification).toBeDefined();
    expect(new Headers(verification?.[1]?.headers).get('Authorization')).toBe(
      'Bearer kilo-session-token'
    );
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

  /**
   * An env whose KILO_MCP_OAUTH_STORE namespace records created protected
   * requests and scripts what `submit_otp` finds. `getByName` returns the DO
   * stub the worker asks for.
   */
  function envWithProtectedStore(
    created: Array<Record<string, unknown>>,
    options?: { peek?: 'pending' | 'gone'; outcome?: OtpSubmitOutcome }
  ): Env {
    return {
      WEB_BASE_URL: 'https://app.kilo.ai',
      KILO_MCP_OAUTH_STORE: {
        getByName: () => ({
          async createProtectedRequest(input: Record<string, unknown>) {
            created.push(input);
            return { id: 'req-api', expiresAt: '2026-09-16T00:05:00.000Z' };
          },
          async peekProtectedRequest() {
            return options?.peek === 'gone' ? { status: 'gone' } : { status: 'pending' };
          },
          async verifyOtpAndClaim() {
            return options?.outcome ?? { status: 'not_pending' };
          },
        }),
      },
    } as unknown as Env;
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

  /**
   * A real admin-guarded row in the bundled catalog that takes no input.
   * `organizations.admin.*` paths are excluded from the dump (the generator
   * publishes admin-guarded procedures only under non-internal paths), so an
   * actual catalog row is used to exercise the guard end to end.
   */
  const REAL_ADMIN_PATH = 'mcpGateway.listPersonal';

  it('refuses a bundled admin path for a grant without the admin opt-in, before any upstream request', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const { ctx } = apiContext({
      kiloUserId: 'user-1',
      organizationId: 'org-1',
      kiloToken: 'kilo-1',
      clientId: 'client-1',
    });
    const response = await apiHandler.fetch!(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'call', arguments: { path: REAL_ADMIN_PATH } },
        }),
      }),
      { WEB_BASE_URL: 'https://app.kilo.ai' } as Env,
      ctx
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { error: { code: number; message: string } };
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain('is an admin or debug endpoint');
    expect(json.error.message).toContain('Enable admin and debug actions');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('records an opted-in bundled admin path as a protected request through the DO stub, no upstream', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const created: Array<Record<string, unknown>> = [];
    const { ctx } = apiContext({
      kiloUserId: 'user-1',
      organizationId: 'org-1',
      kiloToken: 'kilo-1',
      clientId: 'client-1',
      adminEnabled: true,
      adminEligible: true,
      sessionId: 'sess-1',
    });
    const response = await apiHandler.fetch!(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'call_protected', arguments: { path: REAL_ADMIN_PATH } },
        }),
      }),
      envWithProtectedStore(created),
      ctx
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(json.result.content[0]!.text)).toMatchObject({
      status: 'otp_required',
      request_id: 'req-api',
    });
    expect(created[0]).toMatchObject({
      sessionId: 'sess-1',
      path: REAL_ADMIN_PATH,
      kind: 'admin',
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('runs an opted-in bundled admin path exactly once through submit_otp', async () => {
    const calls: string[] = [];
    const upstream = vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('user.getMe')) return Response.json({ result: { data: { isAdmin: true } } });
      return Response.json({ result: { data: { ok: true } } });
    });
    vi.stubGlobal('fetch', upstream);
    const created: Array<Record<string, unknown>> = [];
    const { ctx } = apiContext({
      kiloUserId: 'user-1',
      organizationId: 'org-1',
      kiloToken: 'kilo-1',
      clientId: 'client-1',
      adminEnabled: true,
      adminEligible: true,
      sessionId: 'sess-1',
    });
    const response = await apiHandler.fetch!(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'submit_otp', arguments: { request_id: 'req-api', otp: '123456' } },
        }),
      }),
      envWithProtectedStore(created, {
        outcome: { status: 'ok', path: REAL_ADMIN_PATH, inputJson: null },
      }),
      ctx
    );
    const json = (await response.json()) as { result: { content: Array<{ text: string }> } };
    expect(json.result.content[0]!.text).toBe('{"ok":true}');
    expect(calls.filter(url => url.includes(`/api/trpc/${REAL_ADMIN_PATH}`))).toHaveLength(1);
  });

  it('search omits bundled admin rows for a grant without the opt-in and returns them when it opted in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}))
    );
    const search = async (adminEnabled?: boolean): Promise<string> => {
      const { ctx } = apiContext({
        kiloUserId: 'user-1',
        organizationId: 'org-1',
        kiloToken: 'kilo-1',
        clientId: 'client-1',
        ...(adminEnabled ? { adminEnabled } : {}),
      });
      const response = await apiHandler.fetch!(
        new Request('https://kilo-mcp.test/mcp', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'search', arguments: { query: REAL_ADMIN_PATH } },
          }),
        }),
        { WEB_BASE_URL: 'https://app.kilo.ai' } as Env,
        ctx
      );
      return ((await response.json()) as { result: { content: Array<{ text: string }> } }).result
        .content[0]!.text;
    };
    expect(await search()).not.toContain(REAL_ADMIN_PATH);
    expect(await search(true)).toContain(REAL_ADMIN_PATH);
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

  it('an ambiguous mutation transport failure emits upstream_unreachable_ambiguous', async () => {
    const upstream = vi.fn(() => Promise.reject(new Error('network down')));
    const { captured, promises, handler } = createHarness({
      upstreamFetchImpl: upstream as unknown as typeof fetch,
    });
    await post(handler, {
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: { name: 'call', arguments: { path: 'teams.create', input: { name: 'core' } } },
    });
    await settle(promises);

    const toolEvents = eventsNamed(captured, 'kilo_mcp_tool_called');
    expect(toolEvents).toHaveLength(1);
    expect(propertiesOf(toolEvents[0]!)).toMatchObject({
      tool: 'call',
      path: 'teams.create',
      success: false,
      errorClass: 'upstream_unreachable_ambiguous',
    });
    expect(eventsNamed(captured, 'kilo_mcp_call_rejected')).toHaveLength(0);
  });

  it('a mutation app-level 5xx error emits upstream_unreachable_ambiguous, not upstream_error', async () => {
    // The app answered, but a 5xx-class tRPC error can follow a committed
    // write: the class must say the outcome is unknown, not that the request
    // failed cleanly.
    const upstream = vi.fn(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              message: 'Output validation failed',
              code: -32603,
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'teams.create' },
            },
          },
          { status: 500 }
        )
      )
    );
    const { captured, promises, handler } = createHarness({
      upstreamFetchImpl: upstream as unknown as typeof fetch,
    });
    await post(handler, {
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: { name: 'call', arguments: { path: 'teams.create', input: { name: 'core' } } },
    });
    await settle(promises);

    const toolEvents = eventsNamed(captured, 'kilo_mcp_tool_called');
    expect(toolEvents).toHaveLength(1);
    expect(propertiesOf(toolEvents[0]!)).toMatchObject({
      tool: 'call',
      path: 'teams.create',
      success: false,
      errorClass: 'upstream_unreachable_ambiguous',
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
