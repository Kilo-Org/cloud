import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { createMcpHandler } from './index';
import { ANONYMOUS_DISTINCT_ID, createMcpAnalytics } from './analytics';
import { ORGANIZATION_ID_HEADER } from './auth';
import { decodeJwt, signJwt } from './auth/jwt';
import type {
  OAuthCodeRecord,
  OAuthStoreApi,
  RefreshTokenRecord,
  StoredClient,
} from './store/oauth-store';
import type { Catalog } from './types';

// `cloudflare:workers` does not exist under plain node vitest; the DO import
// only extends its base class, so a stub base is enough. Vitest hoists this
// above the static imports, and the factory closes over nothing.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

/** The default fetch handler takes the Worker ExecutionContext; these tests are
 * not exercising analytics scheduling, so a no-op sink is enough. */
const TEST_CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** Call the default fetch handler with the required ExecutionContext filled in. */
function workerFetch(request: Request, env: Env): Promise<Response> {
  return worker.fetch(request, env, TEST_CTX);
}

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

const AUTH_HEADERS = {
  Authorization: 'Bearer tok_123',
  'Content-Type': 'application/json',
};

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
  headers: Record<string, string> = AUTH_HEADERS
) {
  const response = await handler(
    new Request('https://kilo-mcp.test/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  );
  return response;
}

async function rpcResult(body: unknown, fetchImpl?: typeof fetch) {
  const response = await rpc(makeHandler(fetchImpl), body);
  return { response, json: (await response.json()) as Record<string, unknown> };
}

describe('routing and transport', () => {
  const env = { WEB_BASE_URL: 'https://app.kilo.ai' } as Env;

  it('serves MCP only at /mcp: unknown routes are 404', async () => {
    const response = await workerFetch(new Request('https://kilo-mcp.test/other'), env);
    expect(response.status).toBe(404);
  });

  it('answers CORS preflight with the shared header set', async () => {
    const response = await workerFetch(
      new Request('https://kilo-mcp.test/mcp', { method: 'OPTIONS' }),
      env
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('is stateless POST-only: GET /mcp is 405', async () => {
    const response = await workerFetch(
      new Request('https://kilo-mcp.test/mcp', { method: 'GET' }),
      env
    );
    expect(response.status).toBe(405);
  });

  it('requires a bearer token: 401 before any catalog or upstream work', async () => {
    const handler = makeHandler();
    const response = await handler(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      })
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer error="invalid_token", resource_metadata="https://kilo-mcp.test/.well-known/oauth-protected-resource"'
    );
    const json = (await response.json()) as { error: { code: number } };
    expect(json.error.code).toBe(-32001);
  });

  it('rejects a parse error and a batch request', async () => {
    const handler = makeHandler();
    const bad = await handler(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: '{not json',
      })
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

  it('ping returns an empty result', async () => {
    const { json } = await rpcResult({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect((json as { result: unknown }).result).toEqual({});
  });

  it('tools/list returns exactly search and call, each telling the agent to search first', async () => {
    const { json } = await rpcResult({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
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

  it('invalid arguments are a JSON-RPC invalid-params error', async () => {
    const { json } = await rpcResult({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'search', arguments: {} },
    });
    expect((json as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('unknown tool names are rejected', async () => {
    const { json } = await rpcResult({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'delete', arguments: {} },
    });
    expect((json as { error: { code: number; message: string } }).error.message).toContain(
      'Unknown tool'
    );
  });
});

describe('tools/call call', () => {
  it('happy: forwards a valid call and returns the unwrapped tRPC data', async () => {
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
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok_123');
  });

  it('passes the organization header through to apps/web', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { data: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    await rpc(
      makeHandler(fetchImpl),
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'call', arguments: { path: 'organizations.list' } },
      },
      { ...AUTH_HEADERS, [ORGANIZATION_ID_HEADER]: 'org-uuid-1' }
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)[ORGANIZATION_ID_HEADER]).toBe('org-uuid-1');
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
 * s5 auth-endpoint routing: the default fetch handler wires every OAuth route
 * (discovery metadata, DCR, authorize + pairing status, token) and verifies
 * MCP tokens on /mcp when the worker carries the OAuth bindings.
 */
describe('auth endpoint routing (s5)', () => {
  const ISSUER = 'https://kilo-mcp.test';
  const SECRET = 'routing-test-secret';
  /** RFC 7636 appendix B test vector — a valid 43-char S256 challenge. */
  const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  function createRoutingStore(): OAuthStoreApi & {
    clients: Map<string, StoredClient>;
    codes: Map<string, OAuthCodeRecord>;
    refreshTokens: Map<string, RefreshTokenRecord>;
  } {
    const clients = new Map<string, StoredClient>();
    const codes = new Map<string, OAuthCodeRecord>();
    const refreshTokens = new Map<string, RefreshTokenRecord>();
    const unused = (): never => {
      throw new Error('not reachable from routing tests');
    };
    return {
      clients,
      codes,
      refreshTokens,
      async registerClient(input) {
        clients.set(input.clientId, { ...input, redirectUris: [...input.redirectUris] });
      },
      async getClient(clientId) {
        const client = clients.get(clientId);
        return client ? { ...client, redirectUris: [...client.redirectUris] } : null;
      },
      async createCode(input) {
        codes.set(input.code, {
          ...input,
          status: 'pending',
          kiloUserId: null,
          organizationId: null,
          kiloToken: null,
        });
      },
      async getCode(code) {
        const record = codes.get(code);
        return record ? { ...record } : null;
      },
      async recordPairingApproval(deviceAuthCode, identity, nowIso) {
        for (const [code, record] of codes) {
          if (
            record.deviceAuthCode === deviceAuthCode &&
            record.status === 'pending' &&
            record.kiloUserId === null &&
            record.expiresAt > nowIso
          ) {
            codes.set(code, {
              ...record,
              kiloUserId: identity.kiloUserId,
              kiloToken: identity.kiloToken,
            });
            return true;
          }
        }
        return false;
      },
      async denyCode(deviceAuthCode, nowIso) {
        for (const [code, record] of codes) {
          if (
            record.deviceAuthCode === deviceAuthCode &&
            record.status === 'pending' &&
            record.expiresAt > nowIso
          ) {
            codes.set(code, { ...record, status: 'denied' });
            return true;
          }
        }
        return false;
      },
      async markCodeExpired(deviceAuthCode, nowIso) {
        for (const [code, record] of codes) {
          if (
            record.deviceAuthCode === deviceAuthCode &&
            record.status === 'pending' &&
            record.expiresAt > nowIso
          ) {
            codes.set(code, { ...record, status: 'expired' });
            return true;
          }
        }
        return false;
      },
      async approveCode(deviceAuthCode, identity, nowIso) {
        for (const [code, record] of codes) {
          if (
            record.deviceAuthCode === deviceAuthCode &&
            record.status === 'pending' &&
            record.expiresAt > nowIso
          ) {
            codes.set(code, {
              ...record,
              status: 'approved',
              kiloUserId: identity.kiloUserId,
              organizationId: identity.organizationId,
            });
            return true;
          }
        }
        return false;
      },
      async consumeCode(code, nowIso) {
        const record = codes.get(code);
        if (!record || record.status !== 'approved' || record.expiresAt <= nowIso) return null;
        const used: OAuthCodeRecord = { ...record, status: 'used' };
        codes.set(code, used);
        return { ...used };
      },
      async saveRefreshToken(input) {
        refreshTokens.set(input.id, { ...input, revokedAt: null });
      },
      async getRefreshTokenByHash(tokenHash) {
        const record = [...refreshTokens.values()].find(r => r.tokenHash === tokenHash);
        return record ? { ...record } : null;
      },
      async rotateRefreshToken(oldId, input, nowIso) {
        const old = refreshTokens.get(oldId);
        if (!old || old.revokedAt !== null || old.expiresAt <= nowIso) return false;
        refreshTokens.set(oldId, { ...old, revokedAt: nowIso });
        refreshTokens.set(input.id, { ...input, revokedAt: null });
        return true;
      },
      async getKiloToken(identity) {
        for (const grant of [...refreshTokens.values()].reverse()) {
          if (
            grant.kiloUserId === identity.kiloUserId &&
            grant.clientId === identity.clientId &&
            grant.organizationId === identity.organizationId &&
            grant.resource === identity.resource &&
            grant.revokedAt === null &&
            grant.kiloToken
          ) {
            return grant.kiloToken;
          }
        }
        // The s5 verification tests mint tokens for user-1/c-1/org-1 without
        // going through the exchange; that grant keeps a standing credential.
        return identity.kiloUserId === 'user-1' &&
          identity.clientId === 'c-1' &&
          identity.organizationId === 'org-1' &&
          identity.resource === `${ISSUER}/mcp`
          ? 'kilo-forward-me'
          : null;
      },
      revokeGrant: unused,
      revokeJti: unused,
      async isJtiRevoked() {
        return false;
      },
      purgeExpired: unused,
    };
  }

  function oauthEnv(store: OAuthStoreApi, bindings: 'required' | 'absent' = 'required'): Env {
    return {
      WEB_BASE_URL: 'https://app.kilo.ai',
      ...(bindings === 'required'
        ? {
            MCP_TOKEN_SECRET: SECRET,
            KILO_MCP_OAUTH_STORE: {
              getByName: (name: string) => {
                expect(name).toBe('kilo-mcp-oauth');
                return store;
              },
            },
          }
        : {}),
    } as unknown as Env;
  }

  async function fetchJson(path: string, init?: RequestInit) {
    const response = await workerFetch(
      new Request(`${ISSUER}${path}`, init),
      oauthEnv(createRoutingStore())
    );
    return { response, json: (await response.json()) as Record<string, unknown> };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves authorization-server metadata at both well-known URLs', async () => {
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/mcp',
    ]) {
      const { response, json } = await fetchJson(path);
      expect(response.status).toBe(200);
      expect(json.issuer).toBe(ISSUER);
      expect(json.authorization_endpoint).toBe(`${ISSUER}/authorize`);
      expect(json.token_endpoint).toBe(`${ISSUER}/token`);
      expect(json.registration_endpoint).toBe(`${ISSUER}/register`);
      expect(json.response_types_supported).toEqual(['code']);
      expect(json.code_challenge_methods_supported).toEqual(['S256']);
      expect(json.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(json.scopes_supported).toEqual(['mcp']);
      expect(json.token_endpoint_auth_methods_supported).toEqual(['none']);
    }
  });

  it('serves protected-resource metadata advertising this MCP and its authorization server', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const { response, json } = await fetchJson(path);
      expect(response.status).toBe(200);
      expect(json.resource).toBe(`${ISSUER}/mcp`);
      expect(json.resource_name).toBe('Kilo MCP');
      expect(json.authorization_servers).toEqual([ISSUER]);
      expect(json.scopes_supported).toEqual(['mcp']);
    }
  });

  it('POST /register persists a public client and answers 201 without a secret', async () => {
    const store = createRoutingStore();
    const response = await workerFetch(
      new Request(`${ISSUER}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://client.test/cb'], client_name: 'Router' }),
      }),
      oauthEnv(store)
    );
    expect(response.status).toBe(201);
    const json = (await response.json()) as Record<string, unknown>;
    expect(typeof json.client_id).toBe('string');
    expect(json.client_secret).toBeUndefined();
    expect(json.token_endpoint_auth_method).toBe('none');
    expect(store.clients.get(json.client_id as string)?.clientName).toBe('Router');
  });

  it('GET /authorize creates the pending pairing record and links to Kilo sign-in', async () => {
    const store = createRoutingStore();
    await store.registerClient({
      clientId: 'c-1',
      redirectUris: ['https://client.test/cb'],
      clientName: 'Router',
      createdAt: new Date().toISOString(),
    });
    const deviceAuthFetch = vi.fn(async () => Response.json({ code: 'PAIR-777' }));
    vi.stubGlobal('fetch', deviceAuthFetch);

    const url = new URL(`${ISSUER}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', 'c-1');
    url.searchParams.set('redirect_uri', 'https://client.test/cb');
    url.searchParams.set('code_challenge', CHALLENGE);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('resource', `${ISSUER}/mcp`);
    url.searchParams.set('state', 'st-1');
    const response = await workerFetch(new Request(url.toString()), oauthEnv(store));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('https://app.kilo.ai/device-auth?code=PAIR-777');
    expect(deviceAuthFetch).toHaveBeenCalledTimes(1);
    const [calledUrl] = deviceAuthFetch.mock.calls[0] as unknown as [string];
    expect(String(calledUrl)).toBe('https://app.kilo.ai/api/device-auth/codes');

    expect(store.codes.size).toBe(1);
    const record = [...store.codes.values()][0]!;
    expect(record.clientId).toBe('c-1');
    expect(record.status).toBe('pending');
    expect(record.codeChallenge).toBe(CHALLENGE);
    expect(record.resource).toBe(`${ISSUER}/mcp`);
    expect(record.deviceAuthCode).toBe('PAIR-777');

    // The consent page polls this same worker for pairing status.
    const status = await fetchJsonOn(store, `/authorize/status?code=${record.code}`);
    expect(status.json).toEqual({ status: 'pending' });
  });

  async function fetchJsonOn(store: OAuthStoreApi, path: string) {
    const response = await workerFetch(new Request(`${ISSUER}${path}`), oauthEnv(store));
    return { response, json: (await response.json()) as Record<string, unknown> };
  }

  it('GET /authorize/status cannot be used to probe pairing codes', async () => {
    const store = createRoutingStore();
    const unknown = await fetchJsonOn(store, '/authorize/status?code=does-not-exist');
    expect(unknown.response.status).toBe(200);
    expect(unknown.json).toEqual({ status: 'unknown' });
  });

  it('browser flow end to end: consent -> pairing -> org picker -> token -> call AS the chosen identity', async () => {
    const store = createRoutingStore();
    await store.registerClient({
      clientId: 'c-1',
      redirectUris: ['https://client.test/cb'],
      clientName: 'Router',
      createdAt: new Date().toISOString(),
    });
    let pairingApproved = false;
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers });
      if (url === 'https://app.kilo.ai/api/device-auth/codes')
        return Response.json({ code: 'PAIR-E2E' });
      if (url === 'https://app.kilo.ai/api/device-auth/codes/PAIR-E2E') {
        return pairingApproved
          ? Response.json({ status: 'approved', token: 'kilo-e2e-token', userId: 'user-e2e' })
          : Response.json({ status: 'pending' }, { status: 202 });
      }
      if (url.startsWith('https://app.kilo.ai/api/trpc/organizations.list')) {
        return Response.json({
          result: { data: [{ organizationId: 'org-e2e', organizationName: 'E2E Org' }] },
        });
      }
      // The call step: echo what apps/web actually received as identity.
      if (url.startsWith('https://app.kilo.ai/api/trpc/user.getBalance')) {
        return Response.json({
          result: {
            data: {
              balance: 42,
              seenAuthorization: headers['Authorization'],
              seenOrganization: headers[ORGANIZATION_ID_HEADER],
            },
          },
        });
      }
      return Response.json({ error: { message: `stub: unexpected ${url}` } }, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const env = oauthEnv(store);

    // 1. GET /authorize -> consent page + pending pairing record.
    const authorizeUrl = new URL(`${ISSUER}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', 'c-1');
    authorizeUrl.searchParams.set('redirect_uri', 'https://client.test/cb');
    authorizeUrl.searchParams.set('code_challenge', CHALLENGE);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('resource', `${ISSUER}/mcp`);
    authorizeUrl.searchParams.set('state', 'st-1');
    const consent = await workerFetch(new Request(authorizeUrl.toString()), env);
    expect(consent.status).toBe(200);
    const record = [...store.codes.values()][0]!;

    // 2. Polling before the user approves: still pending.
    const pollUrl = `${ISSUER}/authorize/status?code=${record.code}`;
    expect(await (await workerFetch(new Request(pollUrl), env)).json()).toEqual({
      status: 'pending',
    });

    // 3. User approves the Kilo sign-in -> the worker holds the pairing and
    //    sends the page to the org picker.
    pairingApproved = true;
    expect(await (await workerFetch(new Request(pollUrl), env)).json()).toEqual({
      status: 'needs_org',
      picker_url: `/authorize/org?code=${record.code}`,
    });
    // The single-use approved answer is never polled again.
    const pollCalls = calls.filter(c => c.url.includes('/api/device-auth/codes/')).length;
    expect(pollCalls).toBe(2);

    // 4. GET the picker: personal + the user's organization.
    const picker = await workerFetch(
      new Request(`${ISSUER}/authorize/org?code=${record.code}`),
      env
    );
    const pickerHtml = await picker.text();
    expect(pickerHtml).toContain('E2E Org');
    expect(pickerHtml).toContain('Personal account');

    // 5. POST the selection -> authorize completes with a client redirect.
    const done = await workerFetch(
      new Request(`${ISSUER}/authorize/org?code=${record.code}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'org-e2e' }).toString(),
      }),
      env
    );
    expect(done.status).toBe(302);
    const location = new URL(done.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe('https://client.test/cb');
    expect(location.searchParams.get('code')).toBe(record.code);
    expect(location.searchParams.get('state')).toBe('st-1');

    // 6. Token exchange (PKCE verifier = the RFC 7636 Appendix B vector).
    const tokenResponse = await workerFetch(
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: record.code,
          client_id: 'c-1',
          redirect_uri: 'https://client.test/cb',
          code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
          resource: `${ISSUER}/mcp`,
        }).toString(),
      }),
      env
    );
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as { access_token: string };
    const claims = decodeJwt(tokens.access_token)!.payload;
    expect(claims).toMatchObject({ sub: 'user-e2e', org: 'org-e2e', aud: `${ISSUER}/mcp` });

    // 7. tools/call with the MCP token: apps/web sees the Kilo bearer and the
    //    org from the token claims — the picked identity, end to end.
    calls.length = 0;
    const call = await workerFetch(
      new Request(`${ISSUER}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'call', arguments: { path: 'user.getBalance' } },
        }),
      }),
      env
    );
    const callJson = (await call.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(callJson.result.content[0]!.text)).toMatchObject({
      balance: 42,
      seenAuthorization: 'Bearer kilo-e2e-token',
      seenOrganization: 'org-e2e',
    });
    // A spoofed caller org header changes nothing: the claim wins.
    const spoofed = await workerFetch(
      new Request(`${ISSUER}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'content-type': 'application/json',
          [ORGANIZATION_ID_HEADER]: 'attacker-org',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'call', arguments: { path: 'user.getBalance' } },
        }),
      }),
      env
    );
    const spoofedJson = (await spoofed.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(spoofedJson.result.content[0]!.text)).toMatchObject({
      seenOrganization: 'org-e2e',
    });

    // 8. search runs under the same enforced token.
    const search = await workerFetch(
      new Request(`${ISSUER}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'search', arguments: { query: 'credit balance' } },
        }),
      }),
      env
    );
    expect(search.status).toBe(200);
    const searchJson = (await search.json()) as { result: { content: Array<{ text: string }> } };
    expect(searchJson.result.content[0]!.text).toContain('user.getBalance');
  });

  it('POST /token answers RFC 6749 errors through the route', async () => {
    const unsupported = await fetchJson('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password' }).toString(),
    });
    expect(unsupported.response.status).toBe(400);
    expect(unsupported.json.error).toBe('unsupported_grant_type');

    const garbage = await fetchJson('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'not-an-oauth-body',
    });
    expect(garbage.json.error).toBe('invalid_request');
  });

  it('/mcp verifies this worker MCP tokens when the OAuth bindings are present', async () => {
    const store = createRoutingStore();
    const env = oauthEnv(store);
    const claims = {
      iss: ISSUER,
      sub: 'user-1',
      org: 'org-1',
      aud: `${ISSUER}/mcp`,
      client_id: 'c-1',
      jti: 'j-1',
    };
    const live = await signJwt({ ...claims, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const expired = await signJwt({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

    const ok = await workerFetch(
      new Request(`${ISSUER}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${live}`, 'content-type': 'application/json' },
        body: JSON.stringify(rpc),
      }),
      env
    );
    expect(ok.status).toBe(200);

    const rejected = await workerFetch(
      new Request(`${ISSUER}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${expired}`, 'content-type': 'application/json' },
        body: JSON.stringify(rpc),
      }),
      env
    );
    expect(rejected.status).toBe(401);

    // s6 enforcement: a foreign bearer is rejected outright — /mcp accepts
    // ONLY MCP tokens signed by this worker.
    const foreign = await workerFetch(
      new Request(`${ISSUER}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tok_123', 'content-type': 'application/json' },
        body: JSON.stringify(rpc),
      }),
      env
    );
    expect(foreign.status).toBe(401);
    expect(foreign.headers.get('WWW-Authenticate')).toBe(
      `Bearer error="invalid_token", resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`
    );
  });

  it('a live MCP token whose grant lost its Kilo credential is rejected (reconnect)', async () => {
    const store = createRoutingStore();
    const env = oauthEnv(store);
    // user-2 has no getKiloToken mapping in the routing fake.
    const token = await signJwt(
      {
        iss: ISSUER,
        sub: 'user-2',
        org: 'org-1',
        aud: `${ISSUER}/mcp`,
        client_id: 'c-1',
        jti: 'j-2',
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      SECRET
    );
    const response = await workerFetch(
      new Request(`${ISSUER}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      env
    );
    expect(response.status).toBe(401);
  });

  it('/mcp refuses every bearer on a worker without the OAuth bindings (s6: no unverified passthrough)', async () => {
    const response = await workerFetch(
      new Request(`${ISSUER}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tok_123', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      oauthEnv(createRoutingStore(), 'absent')
    );
    expect(response.status).toBe(503);
  });
});

/**
 * s2 analytics wiring: the /mcp transport emits PostHog events through the
 * injected emitter. Captures are recorded through a fake fetch; the test awaits
 * the `waitUntil` promises before asserting.
 */
describe('analytics wiring (s2)', () => {
  const ANALYTICS_HEADERS = {
    Authorization: 'Bearer tok_123',
    'Content-Type': 'application/json',
  };

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
    headers: Record<string, string> = ANALYTICS_HEADERS
  ): Promise<Response> {
    return handler(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
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

  it('a missing bearer emits an anonymous auth_failure rejection', async () => {
    const { captured, promises, handler } = createHarness();
    const response = await handler(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'initialize' }),
      })
    );
    expect(response.status).toBe(401);
    await settle(promises);

    const rejected = eventsNamed(captured, 'kilo_mcp_call_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!['distinct_id']).toBe(ANONYMOUS_DISTINCT_ID);
    const properties = propertiesOf(rejected[0]!);
    expect(properties).toMatchObject({ reason: 'auth_failure', $process_person_profile: false });
    expect(properties).not.toHaveProperty('userId');
    expect(properties).not.toHaveProperty('organizationId');
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
      expect(JSON.stringify(payload)).not.toContain('tok_123');
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

  it('a verified MCP token binds the event to the user and the organization', async () => {
    const issuer = 'https://kilo-mcp.test';
    const secret = 'analytics-test-secret';
    const store = {
      isJtiRevoked: async () => false,
      getKiloToken: async () => 'kilo-forward-me',
    } as unknown as OAuthStoreApi;
    const token = await signJwt(
      {
        iss: issuer,
        sub: 'user-1',
        org: 'org-1',
        aud: `${issuer}/mcp`,
        client_id: 'c-1',
        jti: 'j-analytics',
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      secret
    );

    const captured: Array<Record<string, unknown>> = [];
    const promises: Promise<unknown>[] = [];
    const ctx: FakeCtx = {
      waitUntil: promise => {
        promises.push(promise);
      },
    };
    const analytics = createMcpAnalytics({
      env: { NEXT_PUBLIC_POSTHOG_KEY: 'phc_test' },
      ctx,
      fetchImpl: ((_url: string | URL, init?: RequestInit) => {
        const rawBody = init?.body;
        captured.push(
          JSON.parse(typeof rawBody === 'string' ? rawBody : '{}') as Record<string, unknown>
        );
        return Promise.resolve(new Response('{}', { status: 200 }));
      }) as unknown as typeof fetch,
      log: console.log,
    });
    const upstream = vi.fn(() =>
      Promise.resolve(Response.json({ result: { data: { balance: 42 } } }))
    );
    const handler = createMcpHandler({
      catalog: testCatalog,
      webBaseUrl: 'https://app.kilo.ai',
      fetchImpl: upstream as unknown as typeof fetch,
      mcpAuth: { tokenSecret: secret, store },
      analytics,
    });

    const response = await handler(
      new Request(`${issuer}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 16,
          method: 'tools/call',
          params: { name: 'call', arguments: { path: 'organizations.list' } },
        }),
      })
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
