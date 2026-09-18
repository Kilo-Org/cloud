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
  'organizations.create': {
    path: 'organizations.create',
    kind: 'mutation',
    summary: 'Create an organization.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { name: { type: 'string', minLength: 1 } },
      required: ['name'],
      additionalProperties: false,
    },
    tags: ['organizations'],
    searchBlob: 'organizations.create Create an organization. organizations create name',
  },
  'cliSessions.revokeAll': {
    path: 'cliSessions.revokeAll',
    kind: 'mutation',
    summary: 'Revoke every CLI session for the user.',
    inputSchema: {},
    tags: ['clisessions'],
    searchBlob: 'cliSessions.revokeAll Revoke every CLI session for the user. clisessions revoke',
  },
  // A void-returning mutation, like the real agentProfiles.bindToRepo: its tRPC
  // success body is `{"result":{}}` because JSON.stringify drops `undefined`.
  'agentProfiles.bindToRepo': {
    path: 'agentProfiles.bindToRepo',
    kind: 'mutation',
    summary: 'Bind an agent profile to a repository.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        profileId: { type: 'string', minLength: 1 },
        repoFullName: { type: 'string', minLength: 1 },
      },
      required: ['profileId', 'repoFullName'],
      additionalProperties: false,
    },
    tags: ['agentprofiles'],
    searchBlob:
      'agentProfiles.bindToRepo Bind an agent profile to a repository. agentprofiles bind repo',
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

  it('forwards a valid mutation as a POST with a JSON body, no input param, and the same headers as the GET case', async () => {
    const fetchImpl = vi.fn(async () => upstreamResponse({ result: { data: { id: 'org-new' } } }));
    const outcome = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'organizations.create',
      input: { name: 'acme' },
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    });
    expect(outcome).toEqual({ text: '{"id":"org-new"}', truncated: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin).toBe(WEB_BASE_URL);
    expect(parsed.pathname).toBe('/api/trpc/organizations.create');
    // tRPC accepts a mutation only on POST, so the input must not ride the URL.
    expect(parsed.searchParams.has('input')).toBe(false);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer tok_123');
    expect(headers['x-kilocode-organizationid']).toBe('org-uuid-1');
    expect(init.body).toBe('{"name":"acme"}');
  });

  it('posts {} for a no-input mutation (an empty body would be a 400)', async () => {
    const fetchImpl = vi.fn(async () => upstreamResponse({ result: { data: { revoked: 3 } } }));
    const outcome = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'cliSessions.revokeAll',
      input: undefined,
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    });
    expect(outcome).toEqual({ text: '{"revoked":3}', truncated: false });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.has('input')).toBe(false);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('rejects schema-invalid mutation input before any request', async () => {
    const fetchImpl = vi.fn();
    const error = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'organizations.create',
      input: { name: '' },
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).code).toBe(-32602);
    expect((error as Error).message).toContain('published schema');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a void mutation result as success: {"result":{}} is not a missing body', async () => {
    // tRPC serializes a void procedure to `{"result":{}}` (JSON.stringify drops
    // the undefined `data` field), and the published bindToRepo/unbindRepo
    // mutations return nothing. Reporting an error after the write landed would
    // make an agent re-apply it.
    const fetchImpl = vi.fn(async () => upstreamResponse({ result: {} }));
    const outcome = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'agentProfiles.bindToRepo',
      input: { profileId: 'prof-1', repoFullName: 'acme/widgets' },
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    });
    expect(outcome).toEqual({ text: 'null', truncated: false });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.has('input')).toBe(false);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"profileId":"prof-1","repoFullName":"acme/widgets"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('does not read a malformed result object as a successful void mutation', async () => {
    // Only the shapes tRPC emits are a success envelope: `{"result":{}}` for a
    // void procedure, or `{"result":{"data":…}}` for one with output. A 2xx body
    // like `{"result":{"nonsense":true}}` is neither, so the write's outcome is
    // unknown — reporting success would tell the agent a change it never made.
    const fetchImpl = vi.fn(async () => upstreamResponse({ result: { nonsense: true } }));
    const error = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'agentProfiles.bindToRepo',
      input: { profileId: 'prof-1', repoFullName: 'acme/widgets' },
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).data).toMatchObject({
      path: 'agentProfiles.bindToRepo',
      ambiguous: true,
    });
    expect((error as Error).message).toContain('may or may not have been applied');
  });

  it('a mutation network failure is ambiguous, never a blind retry, and leaks no token', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed: https://tok_123@secret.invalid');
    });
    const error = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'organizations.create',
      input: { name: 'acme' },
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).data).toMatchObject({ ambiguous: true });
    // Ambiguous is not retryable: the mutation may have landed.
    expect((error as JsonRpcFailure).data?.['retryable']).toBeUndefined();
    expect((error as Error).message).toContain('may or may not have been applied');
    expect((error as Error).message).toContain('check the current state');
    expect((error as Error).message).not.toContain('Retry the call');
    expect((error as Error).message).not.toContain('tok_123');
  });

  it('maps a mutation upstream 4xx to a JSON-RPC error preserving code and httpStatus, and a corrected retry succeeds', async () => {
    const fetchImpl = vi.fn(async () =>
      upstreamResponse(
        {
          error: {
            message: 'Organization name already taken',
            code: -32004,
            data: { code: 'CONFLICT', httpStatus: 409, path: 'organizations.create' },
          },
        },
        409
      )
    );
    const error = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'organizations.create',
      input: { name: 'acme' },
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).message).toBe('Organization name already taken');
    expect((error as JsonRpcFailure).data).toMatchObject({
      trpcCode: 'CONFLICT',
      httpStatus: 409,
    });
    // The app answered, so the outcome is known: no ambiguity wording.
    expect((error as Error).message).not.toContain('may or may not');

    // a corrected retry succeeds
    const retryFetch = vi.fn(async () => upstreamResponse({ result: { data: { id: 'org-new' } } }));
    await expect(
      callCatalogEndpoint({
        catalog: testCatalog,
        path: 'organizations.create',
        input: { name: 'acme-2' },
        auth,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl: retryFetch,
      })
    ).resolves.toEqual({ text: '{"id":"org-new"}', truncated: false });
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
    // A GET changed nothing, so a blind retry is safe and the message says so.
    expect((error as Error).message).toContain('Retry the call');
    expect((error as JsonRpcFailure).data?.['ambiguous']).toBeUndefined();
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

  it('rejects a 200 query response whose result object is not a tRPC envelope', async () => {
    // A `result` object with keys tRPC never emits is not a success body, so the
    // query must not be handed an arbitrary payload as if it were the data.
    const fetchImpl = vi.fn(async () => upstreamResponse({ result: { nonsense: true } }));
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

  it('reports a mutation gateway 5xx with no tRPC error body as ambiguous, never a blind retry', async () => {
    // app.kilo.ai answers a function timeout with a non-tRPC 504
    // (FUNCTION_INVOCATION_TIMEOUT) or a 502 at the edge. The POST reached the
    // platform, so the write may have landed: the agent must check state, not
    // retry. The same holds for a JSON body that is not a tRPC error envelope.
    const bodies: Array<() => Response> = [
      () => new Response('bad gateway', { status: 502 }),
      () => new Response('An error occurred with your deployment', { status: 504 }),
      () => upstreamResponse({ error: 'FUNCTION_INVOCATION_TIMEOUT' }, 504),
    ];
    for (const makeResponse of bodies) {
      const fetchImpl = vi.fn(async () => makeResponse());
      const error = await callCatalogEndpoint({
        catalog: testCatalog,
        path: 'organizations.create',
        input: { name: 'acme' },
        auth,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JsonRpcFailure);
      expect((error as JsonRpcFailure).data).toMatchObject({
        path: 'organizations.create',
        ambiguous: true,
      });
      // Ambiguous is not retryable: the mutation may have applied.
      expect((error as JsonRpcFailure).data?.['retryable']).toBeUndefined();
      expect((error as Error).message).toContain('may or may not have been applied');
      expect((error as Error).message).toContain('check the current state');
      expect((error as JsonRpcFailure).data?.['httpStatus']).toBeUndefined();
    }
  });

  it('leaves a query gateway 5xx without a tRPC error body as an ordinary upstream error', async () => {
    // A GET changed nothing, so the retry guidance stays honest and non-ambiguous.
    const fetchImpl = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    const error = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'organizations.list',
      input: undefined,
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as Error).message).toContain('failed with HTTP 502');
    expect((error as JsonRpcFailure).data?.['ambiguous']).toBeUndefined();
  });

  it('reports a mutation 5xx-class app-level tRPC error as ambiguous, never a blind retry', async () => {
    // tRPC raises a 5xx-class error AFTER the resolver returned — output
    // validation, a post-resolver middleware — so a committed write can still
    // come back as an error envelope. The app answered, but the outcome is
    // unknown: reporting a known failure here invites a duplicate write.
    for (const [status, code] of [
      [500, 'INTERNAL_SERVER_ERROR'],
      [501, 'NOT_IMPLEMENTED'],
    ] as const) {
      const fetchImpl = vi.fn(async () =>
        upstreamResponse(
          {
            error: {
              message: 'Output validation failed',
              code: -32603,
              data: { code, httpStatus: status, path: 'organizations.create' },
            },
          },
          status
        )
      );
      const error = await callCatalogEndpoint({
        catalog: testCatalog,
        path: 'organizations.create',
        input: { name: 'acme' },
        auth,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JsonRpcFailure);
      expect((error as JsonRpcFailure).data).toMatchObject({
        path: 'organizations.create',
        ambiguous: true,
        httpStatus: status,
      });
      // Ambiguous is not retryable, and the tRPC code must not read as a known
      // upstream failure either: the mutation may have applied.
      expect((error as JsonRpcFailure).data?.['retryable']).toBeUndefined();
      expect((error as JsonRpcFailure).data?.['trpcCode']).toBeUndefined();
      expect((error as Error).message).toContain('may or may not have been applied');
      expect((error as Error).message).toContain('check the current state');
      expect((error as Error).message).not.toContain('Retry the call');
    }
  });

  it('leaves a query 5xx-class app-level tRPC error as an ordinary upstream error', async () => {
    // Only a mutation can have landed: a GET changed nothing, so its ordinary
    // mapping (message, trpcCode, httpStatus) stays and no ambiguity wording
    // is added.
    const fetchImpl = vi.fn(async () =>
      upstreamResponse(
        {
          error: {
            message: 'Something went wrong',
            code: -32603,
            data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'organizations.list' },
          },
        },
        500
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
    expect((error as JsonRpcFailure).message).toBe('Something went wrong');
    expect((error as JsonRpcFailure).data).toMatchObject({
      trpcCode: 'INTERNAL_SERVER_ERROR',
      httpStatus: 500,
    });
    expect((error as JsonRpcFailure).data?.['ambiguous']).toBeUndefined();
    expect((error as Error).message).not.toContain('may or may not');
  });

  it('reports a mutation 2xx body it cannot read as ambiguous instead of a false failure', async () => {
    // A landed write whose success body cannot be parsed must not read as a
    // failure, or the agent re-applies the mutation.
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    }));
    const error = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'organizations.create',
      input: { name: 'acme' },
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).data).toMatchObject({
      path: 'organizations.create',
      ambiguous: true,
    });
    expect((error as Error).message).toContain('may or may not have been applied');
    expect((error as Error).message).not.toContain('without a tRPC result body');
  });

  it('reports a mutation 2xx body without a tRPC result as ambiguous, not a false failure', async () => {
    const fetchImpl = vi.fn(async () => upstreamResponse({ nonsense: true }));
    const error = await callCatalogEndpoint({
      catalog: testCatalog,
      path: 'organizations.create',
      input: { name: 'acme' },
      auth,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcFailure);
    expect((error as JsonRpcFailure).data).toMatchObject({ ambiguous: true });
    expect((error as Error).message).toContain('may or may not have been applied');
  });

  it('reports a query 2xx body it cannot read as the existing missing-result error', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    }));
    await expect(
      callCatalogEndpoint({
        catalog: testCatalog,
        path: 'organizations.list',
        input: undefined,
        auth,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
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
