import { describe, expect, it, vi } from 'vitest';
import {
  callCatalogEndpoint,
  executeProtectedCall,
  forwardCatalogCall,
  MAX_RESULT_BYTES,
  requestProtectedCall,
  serializeWithCap,
  TRUNCATION_MARKER,
} from './call';
import {
  JsonRpcFailure,
  type Catalog,
  type ForwardedAuth,
  type OtpSubmitOutcome,
  type ProtectedRequestsApi,
} from './types';

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
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { verbose: { type: 'boolean' } },
      additionalProperties: false,
    },
    tags: ['debug'],
    searchBlob: 'debug.getState Read the debug platform state. debug getstate state',
    debug: true,
  },
};

const auth: ForwardedAuth = {
  authorization: 'Bearer tok_123',
  organizationId: 'org-uuid-1',
  kiloUserId: 'user-1',
  clientId: 'client-1',
};

/** The same grant after the OTP opt-in: eligible, enabled, with a connection id. */
const protectedAuth: ForwardedAuth = {
  ...auth,
  adminEnabled: true,
  adminEligible: true,
  sessionId: 'session-1',
};

const WEB_BASE_URL = 'https://app.kilo.ai';

function upstreamResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fake pending-request store capturing what `call_protected` recorded. */
function fakeRequestsStore(options?: {
  id?: string;
  expiresAt?: string;
  peek?: 'pending' | 'gone';
  outcome?: OtpSubmitOutcome;
  throws?: boolean;
}): ProtectedRequestsApi & {
  created: Array<Parameters<ProtectedRequestsApi['createProtectedRequest']>[0]>;
} {
  const created: Array<Parameters<ProtectedRequestsApi['createProtectedRequest']>[0]> = [];
  return {
    created,
    async createProtectedRequest(input) {
      if (options?.throws) throw new Error('Durable Object storage unavailable: tok_123');
      created.push(input);
      return {
        id: options?.id ?? 'req-1',
        expiresAt: options?.expiresAt ?? '2026-09-16T00:05:00.000Z',
      };
    },
    async peekProtectedRequest() {
      return options?.peek === 'gone' ? { status: 'gone' } : { status: 'pending' };
    },
    async verifyOtpAndClaim() {
      return options?.outcome ?? { status: 'not_pending' };
    },
  };
}

/** The local-rejection message a guarded path carries when the grant did not opt in. */
const ADMIN_DENIED_MESSAGE =
  '"admin.getMetrics" is an admin or debug endpoint. Reconnect the Kilo MCP server and tick "Enable admin and debug actions" at sign-in to allow admin and debug actions.';

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

  it('rejects an admin path locally when the grant did not opt in: the checkbox copy, no upstream', async () => {
    for (const authVariant of [{ ...auth, adminEnabled: false }, { ...auth }]) {
      const fetchImpl = vi.fn();
      const error = await callCatalogEndpoint({
        catalog: testCatalog,
        path: 'admin.getMetrics',
        input: undefined,
        auth: authVariant,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JsonRpcFailure);
      expect((error as JsonRpcFailure).code).toBe(-32602);
      expect((error as Error).message).toBe(ADMIN_DENIED_MESSAGE);
      expect((error as JsonRpcFailure).data).toEqual({ path: 'admin.getMetrics' });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('rejects an opted-in admin path locally too, pointing at call_protected, no upstream', async () => {
    for (const path of ['admin.getMetrics', 'debug.getState']) {
      const fetchImpl = vi.fn();
      const error = await callCatalogEndpoint({
        catalog: testCatalog,
        path,
        input: undefined,
        auth: protectedAuth,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JsonRpcFailure);
      expect((error as JsonRpcFailure).code).toBe(-32602);
      expect((error as Error).message).toBe(
        `"${path}" is an admin or debug endpoint. Use the call_protected tool, then submit_otp with the code from your authenticator app, to run it.`
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    }
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

  it('validates input without code generation, so calls work on Cloudflare Workers', async () => {
    // Workerd forbids `new Function` (code generation from strings), which is
    // exactly what AJV needs to compile a schema. The fresh schema object
    // bypasses the validator cache while the Function constructor is
    // unavailable; the fetch fake returns a plain object because stubbing
    // Function also breaks undici's Response constructor.
    const catalog: Catalog = {
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
          'cliSessions.search Search the user CLI sessions by keyword. clisessions search query limit',
      },
    };
    vi.stubGlobal('Function', function () {
      throw new Error('code generation from strings is forbidden on Workerd');
    });
    try {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        json: async () => ({ result: { data: { sessions: [] } } }),
      }));
      const outcome = await callCatalogEndpoint({
        catalog,
        path: 'cliSessions.search',
        input: { query: 'deploy' },
        auth,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(outcome).toEqual({ text: '{"sessions":[]}', truncated: false });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
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
      auth: { authorization: 'Bearer tok_123', kiloUserId: 'user-1', clientId: 'client-1' },
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

  it('rejects any input for a no-input procedure before any request', async () => {
    const fetchImpl = vi.fn();
    const error = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'organizations.list',
      input: { unexpected: true },
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).code).toBe(-32602);
    expect((error as Error).message).toMatch(/takes no input/);
    expect(fetchImpl).not.toHaveBeenCalled();
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

describe('forwardCatalogCall (the shared upstream path)', () => {
  it('is the one GET both tools run: urlencoded input, grant bearer, capped result', async () => {
    const fetchImpl = vi.fn(async () => upstreamResponse({ result: { data: { ok: true } } }));
    const outcome = await forwardCatalogCall({
      row: testCatalog['debug.getState']!,
      input: { verbose: true },
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    });
    expect(outcome).toEqual({ text: '{"ok":true}', truncated: false });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      'https://app.kilo.ai/api/trpc/debug.getState?input=%7B%22verbose%22%3Atrue%7D'
    );
  });
});

describe('requestProtectedCall', () => {
  it('rejects an unknown path with the shared unknown-path message and records nothing', async () => {
    const fetchImpl = vi.fn();
    const requests = fakeRequestsStore();
    const error = await requestProtectedCall({
      catalog: testCatalog,
      path: 'secrets.deleteAll',
      input: undefined,
      auth: protectedAuth,
      requests,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).code).toBe(-32602);
    expect((error as Error).message).toMatch(/Unknown path/);
    expect(requests.created).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-guarded row and points at the call tool', async () => {
    const fetchImpl = vi.fn();
    const requests = fakeRequestsStore();
    const error = await requestProtectedCall({
      catalog: testCatalog,
      path: 'organizations.list',
      input: undefined,
      auth: protectedAuth,
      requests,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).code).toBe(-32602);
    expect((error as Error).message).toBe(
      '"organizations.list" is not an admin or debug endpoint. Use the call tool for it.'
    );
    expect(requests.created).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a schema-invalid input for a guarded row and records nothing', async () => {
    const fetchImpl = vi.fn();
    const requests = fakeRequestsStore();
    const error = await requestProtectedCall({
      catalog: testCatalog,
      path: 'debug.getState',
      input: { verbose: 'yes' },
      auth: protectedAuth,
      requests,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as Error).message).toContain('does not match the published schema');
    expect(requests.created).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('records an admin call with no input and returns otp_required with zero fetches', async () => {
    const fetchImpl = vi.fn();
    const requests = fakeRequestsStore({
      id: 'req-42',
      expiresAt: '2026-09-16T00:05:00.000Z',
    });
    const outcome = await requestProtectedCall({
      catalog: testCatalog,
      path: 'admin.getMetrics',
      input: undefined,
      auth: protectedAuth,
      requests,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    });
    expect(outcome.truncated).toBe(false);
    expect(JSON.parse(outcome.text)).toEqual({
      status: 'otp_required',
      request_id: 'req-42',
      expires_at: '2026-09-16T00:05:00.000Z',
      message:
        'Approval required: ask the user to read the current code from their authenticator app, then call submit_otp with this request_id and that code. The request expires at 2026-09-16T00:05:00.000Z.',
    });
    expect(requests.created).toEqual([
      {
        sessionId: 'session-1',
        kiloUserId: 'user-1',
        clientId: 'client-1',
        path: 'admin.getMetrics',
        kind: 'admin',
        inputJson: null,
        nowIso: expect.any(String),
      },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('records a debug call as kind debug with the reviewed input', async () => {
    const fetchImpl = vi.fn();
    const requests = fakeRequestsStore({ id: 'req-dbg' });
    const outcome = await requestProtectedCall({
      catalog: testCatalog,
      path: 'debug.getState',
      input: { verbose: true },
      auth: protectedAuth,
      requests,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    });
    expect(JSON.parse(outcome.text)).toMatchObject({
      status: 'otp_required',
      request_id: 'req-dbg',
    });
    expect(requests.created).toEqual([
      {
        sessionId: 'session-1',
        kiloUserId: 'user-1',
        clientId: 'client-1',
        path: 'debug.getState',
        kind: 'debug',
        inputJson: '{"verbose":true}',
        nowIso: expect.any(String),
      },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed with a retryable refusal when the pending-request store is missing', async () => {
    const fetchImpl = vi.fn();
    const error = await requestProtectedCall({
      catalog: testCatalog,
      path: 'admin.getMetrics',
      input: undefined,
      auth: protectedAuth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).code).toBe(-32000);
    expect((error as JsonRpcFailure).data).toEqual({
      path: 'admin.getMetrics',
      retryable: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('turns a throwing store into the same retryable refusal, never failing open', async () => {
    const fetchImpl = vi.fn();
    const requests = fakeRequestsStore({ throws: true });
    const error = await requestProtectedCall({
      catalog: testCatalog,
      path: 'admin.getMetrics',
      input: undefined,
      auth: protectedAuth,
      requests,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).code).toBe(-32000);
    // The store's own failure text is never surfaced: it may embed a token.
    expect((error as Error).message).not.toContain('tok_123');
    expect((error as JsonRpcFailure).data).toEqual({
      path: 'admin.getMetrics',
      retryable: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when the grant carries no connection id', async () => {
    const fetchImpl = vi.fn();
    const requests = fakeRequestsStore();
    const error = await requestProtectedCall({
      catalog: testCatalog,
      path: 'admin.getMetrics',
      input: undefined,
      auth: { ...auth, adminEnabled: true, adminEligible: true },
      requests,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).code).toBe(-32000);
    expect(requests.created).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('executeProtectedCall', () => {
  it('runs the recorded guarded path and input exactly once', async () => {
    const fetchImpl = vi.fn(async () => upstreamResponse({ result: { data: { ok: true } } }));
    const outcome = await executeProtectedCall({
      catalog: testCatalog,
      path: 'debug.getState',
      inputJson: '{"verbose":true}',
      auth: protectedAuth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    });
    expect(outcome).toEqual({ text: '{"ok":true}', truncated: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      'https://app.kilo.ai/api/trpc/debug.getState?input=%7B%22verbose%22%3Atrue%7D'
    );
  });

  it('runs a no-input guarded call with no input param', async () => {
    const fetchImpl = vi.fn(async () => upstreamResponse({ result: { data: [1] } }));
    const outcome = await executeProtectedCall({
      catalog: testCatalog,
      path: 'admin.getMetrics',
      inputJson: null,
      auth: protectedAuth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    });
    expect(outcome.text).toBe('[1]');
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.has('input')).toBe(false);
  });

  it('refuses a recorded input that no longer matches the published schema, never rewriting it', async () => {
    const fetchImpl = vi.fn();
    const error = await executeProtectedCall({
      catalog: testCatalog,
      path: 'debug.getState',
      inputJson: '{"verbose":"yes"}',
      auth: protectedAuth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as Error).message).toContain('does not match the published schema');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a recorded input that is not JSON', async () => {
    const fetchImpl = vi.fn();
    const error = await executeProtectedCall({
      catalog: testCatalog,
      path: 'debug.getState',
      inputJson: '{not json',
      auth: protectedAuth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as Error).message).toMatch(/not valid JSON/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses when the recorded path is no longer a guarded catalog row', async () => {
    const fetchImpl = vi.fn();
    // The row was demoted to an ordinary endpoint.
    const demoted: Catalog = {
      'admin.getMetrics': { ...testCatalog['admin.getMetrics']!, admin: undefined },
    };
    const cases: Array<[Catalog, string]> = [
      [demoted, 'admin.getMetrics'],
      [testCatalog, 'admin.removed'],
    ];
    for (const [catalog, path] of cases) {
      const error = await executeProtectedCall({
        catalog,
        path,
        inputJson: null,
        auth: protectedAuth,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JsonRpcFailure);
      expect((error as Error).message).toMatch(/no longer available/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces a tRPC failure from the recorded call with its code and status', async () => {
    const fetchImpl = vi.fn(async () =>
      upstreamResponse(
        {
          error: {
            message: 'Forbidden',
            code: -32003,
            data: { code: 'FORBIDDEN', httpStatus: 403 },
          },
        },
        403
      )
    );
    const error = await executeProtectedCall({
      catalog: testCatalog,
      path: 'admin.getMetrics',
      inputJson: null,
      auth: protectedAuth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).message).toBe('Forbidden');
    expect((error as JsonRpcFailure).data).toMatchObject({
      trpcCode: 'FORBIDDEN',
      httpStatus: 403,
    });
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
