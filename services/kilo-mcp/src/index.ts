import catalogJson from '../catalog.json';
import {
  classifyToolError,
  createMcpAnalytics,
  queryShape,
  type AnalyticsIdentity,
  type CallRejectedReason,
  type McpAnalytics,
} from './analytics';
import { forwardedAuthFromProps } from './auth';
import { MCP_SCOPE, scopeTokens } from './auth/http';
import { callCatalogEndpoint } from './call';
import { createDefaultHandler } from './oauth/consent';
import { onError, tokenExchangeCallback } from './oauth/provider-hooks';
import { createRefreshReuseHandler, isTokenRequest } from './oauth/refresh-reuse';
import {
  callArgsSchema,
  clientRegistrationSchema,
  initializeParamsSchema,
  jsonRpcEnvelopeSchema,
  searchArgsSchema,
  toolsCallParamsSchema,
  type JsonRpcEnvelope,
} from './schemas';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  noSemanticCandidates,
  searchCatalog,
} from './search';
import { createSemanticCandidates } from './search-knn';
import { getKiloMcpOAuthStoreStub, KiloMcpOAuthStore as OAuthStore } from './store/oauth-store';
import {
  JsonRpcFailure,
  type Catalog,
  type ForwardedAuth,
  type GrantProps,
  type SemanticCandidates,
} from './types';
import OAuthProvider, {
  getOAuthApi,
  type ClientRegistrationCallbackOptions,
  type ClientRegistrationCallbackResult,
  type OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider';
import type { ZodError } from 'zod';

/** The bundled catalog dumped by apps/web/src/scripts/mcp-catalog (s1). */
const catalog = catalogJson as unknown as Catalog;

/** JSON-RPC 2.0 error codes (https://www.jsonrpc.org/specification). */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
/** The library already authenticated the request; this is the post-auth "no Kilo token bound" case. */
const UNAUTHORIZED = -32001;

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'kilo-mcp', version: '1.0.0' } as const;

/**
 * The published tool names. `tools/call` accepts any string as `name`, so the
 * value is caller-controlled; analytics records a name only when it is one of
 * these and reports everything else as `unknown`, so arbitrary caller text can
 * never reach PostHog.
 */
const PUBLISHED_TOOL_NAMES = new Set(['search', 'call']);

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

function withCorsHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

function jsonResponse(body: unknown, status = 200): Response {
  return withCorsHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

function jsonRpcResult(id: string | number, result: unknown): Response {
  return jsonResponse({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>
): Response {
  return jsonResponse({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

/** Render zod issues without echoing any caller value (paths and messages only). */
function describeZodIssues(error: ZodError): string {
  return error.issues
    .map(
      issue =>
        `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`
    )
    .join('; ');
}

const TOOLS = [
  {
    name: 'search',
    description:
      'Search the Kilo API catalog for endpoints that match a task. ALWAYS run search first: the call tool only accepts paths this catalog publishes, and search returns the path, summary, and input schema you need for the call.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What you want to do, in the words an agent would type.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: `Maximum number of results (default ${DEFAULT_SEARCH_LIMIT}).`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'call',
    description:
      'Call a Kilo API endpoint by its catalog path. Run search first to find a valid path and its input schema — paths outside the catalog and inputs that violate the published schema are rejected before any request is made.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'A catalog endpoint path returned by search, e.g. "organizations.list".',
        },
        input: {
          type: 'object',
          description:
            'Arguments matching the endpoint input schema from search. Omit for endpoints that take no input.',
          additionalProperties: true,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
] as const;

type McpHandlerDeps = {
  catalog: Catalog;
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
  /** Vectorize kNN hook; token-only search when omitted. */
  semanticCandidates?: SemanticCandidates;
  /**
   * PostHog emitter for this request (s2). Omitted in tests that do not care
   * about analytics; the handler then uses a no-op emitter so behaviour is
   * unchanged. The emitter is best-effort and can never throw.
   */
  analytics?: McpAnalytics;
};

/**
 * Used when a handler is built without an analytics emitter (existing tests,
 * and any caller that does not opt in). Every method is a no-op.
 */
const noopAnalytics: McpAnalytics = {
  sessionStarted: () => {},
  toolCalled: () => {},
  searchPerformed: () => {},
  callRejected: () => {},
  oauthSignIn: () => {},
};

/**
 * The identity an event is bound to. The provider verified the bearer before
 * the API handler runs, so the grant props are the identity; a caller-supplied
 * header never contributes.
 */
function identity(auth: ForwardedAuth): AnalyticsIdentity {
  return { kiloUserId: auth.kiloUserId, organizationId: auth.organizationId ?? null };
}

/** An MCP tools/call success payload. */
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  truncated?: true;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** JSON object guard used only to recover the JSON-RPC `id` from a malformed envelope. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  auth: ForwardedAuth,
  deps: McpHandlerDeps,
  analytics: McpAnalytics,
  callerIdentity: AnalyticsIdentity
): Promise<ToolResult> {
  if (name === 'search') {
    const parsed = searchArgsSchema.safeParse(args);
    if (!parsed.success) {
      throw new JsonRpcFailure(
        INVALID_PARAMS,
        `Invalid search arguments: ${describeZodIssues(parsed.error)}`
      );
    }
    const { query, limit } = parsed.data;
    const results = await searchCatalog(query, {
      catalog: deps.catalog,
      limit,
      semanticCandidates: deps.semanticCandidates ?? noSemanticCandidates,
    });
    // The query's shape only — never the raw text (it can carry personal data).
    analytics.searchPerformed({
      identity: callerIdentity,
      hitCount: results.length,
      empty: results.length === 0,
      ...queryShape(query),
      limit: Math.max(1, Math.floor(limit ?? DEFAULT_SEARCH_LIMIT)),
    });
    if (results.length === 0) {
      // Empty state, not an error: tell the agent how to recover.
      return textResult(
        JSON.stringify({
          results: [],
          message: `No endpoints matched "${query.trim()}". Refine your query: use fewer or different keywords, or describe the task in plain language.`,
        })
      );
    }
    return textResult(JSON.stringify({ results }));
  }
  if (name === 'call') {
    const parsed = callArgsSchema.safeParse(args);
    if (!parsed.success) {
      throw new JsonRpcFailure(
        INVALID_PARAMS,
        `Invalid call arguments: ${describeZodIssues(parsed.error)}`
      );
    }
    const { path, input } = parsed.data;
    const outcome = await callCatalogEndpoint({
      catalog: deps.catalog,
      path,
      input,
      auth,
      webBaseUrl: deps.webBaseUrl,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    return {
      content: [{ type: 'text', text: outcome.text }],
      ...(outcome.truncated ? { truncated: true as const } : {}),
    };
  }
  throw new JsonRpcFailure(
    INVALID_PARAMS,
    `Unknown tool "${name}". Available tools: search, call.`
  );
}

async function handleRpcMessage(
  message: JsonRpcEnvelope,
  auth: ForwardedAuth,
  deps: McpHandlerDeps
): Promise<Response> {
  const id = message.id ?? null;
  const method = message.method;
  const analytics = deps.analytics ?? noopAnalytics;
  const callerIdentity = identity(auth);

  // Notifications carry no id and get no JSON-RPC response body.
  if (id === null && method.startsWith('notifications/')) {
    return withCorsHeaders(new Response(null, { status: 202 }));
  }

  try {
    switch (method) {
      case 'initialize': {
        const parsed = initializeParamsSchema.safeParse(message.params ?? {});
        if (!parsed.success) {
          throw new JsonRpcFailure(
            INVALID_PARAMS,
            `Invalid initialize params: ${describeZodIssues(parsed.error)}`
          );
        }
        const params = parsed.data;
        const protocolVersion = params.protocolVersion ?? PROTOCOL_VERSION;
        const clientName = params.clientInfo?.name;
        analytics.sessionStarted({
          identity: callerIdentity,
          protocolVersion,
          ...(clientName !== undefined ? { clientName } : {}),
        });
        return jsonRpcResult(id ?? 0, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            'This server exposes the Kilo API through two tools: search (find catalog endpoints) and call (invoke one by path). Search before every call.',
        });
      }
      case 'ping':
        return jsonRpcResult(id ?? 0, {});
      case 'tools/list':
        return jsonRpcResult(id ?? 0, { tools: TOOLS });
      case 'tools/call': {
        const parsed = toolsCallParamsSchema.safeParse(message.params);
        if (!parsed.success) {
          throw new JsonRpcFailure(
            INVALID_PARAMS,
            `Invalid tools/call params: ${describeZodIssues(parsed.error)}`
          );
        }
        const toolName = parsed.data.name;
        const args = parsed.data.arguments ?? {};
        // Analytics records only a published tool name; anything else is
        // caller-supplied text and must never reach PostHog verbatim.
        const analyticsTool = PUBLISHED_TOOL_NAMES.has(toolName) ? toolName : 'unknown';
        // The path is only recorded when it is a real catalog key, so a caller
        // cannot put arbitrary text into the event through `path`.
        const path =
          typeof args['path'] === 'string' &&
          Object.prototype.hasOwnProperty.call(deps.catalog, args['path'])
            ? args['path']
            : undefined;
        const startedAt = performance.now();
        try {
          const result = await runTool(toolName, args, auth, deps, analytics, callerIdentity);
          analytics.toolCalled({
            identity: callerIdentity,
            tool: analyticsTool,
            ...(path !== undefined ? { path } : {}),
            success: true,
            errorClass: 'none',
            latencyMs: performance.now() - startedAt,
          });
          return jsonRpcResult(id ?? 0, result);
        } catch (error) {
          const errorClass = classifyToolError(error);
          analytics.toolCalled({
            identity: callerIdentity,
            tool: analyticsTool,
            ...(path !== undefined ? { path } : {}),
            success: false,
            errorClass,
            latencyMs: performance.now() - startedAt,
          });
          // A `call` rejected locally — before any upstream request — is a
          // distinct event: auth failure is handled at the transport above.
          const rejectedReason: CallRejectedReason | null =
            errorClass === 'unknown_path' ||
            errorClass === 'schema_invalid' ||
            errorClass === 'invalid_params'
              ? errorClass
              : null;
          if (toolName === 'call' && rejectedReason) {
            analytics.callRejected({
              identity: callerIdentity,
              reason: rejectedReason,
              ...(path !== undefined ? { path } : {}),
            });
          }
          throw error;
        }
      }
      default:
        return jsonRpcError(id, METHOD_NOT_FOUND, `Unknown method "${method}".`);
    }
  } catch (error) {
    if (error instanceof JsonRpcFailure) {
      return jsonRpcError(id ?? 0, error.code, error.message, error.data);
    }
    throw error;
  }
}

/**
 * The MCP Streamable HTTP endpoint: stateless JSON POST responses for
 * initialize, notifications/initialized, tools/list, tools/call, and ping.
 * The caller passes the grant-derived `auth` the OAuth provider authenticated
 * (see `apiHandler`); this handler never reads the request's bearer itself.
 */
export function createMcpHandler(deps: McpHandlerDeps) {
  return async function handleMcp(request: Request, auth: ForwardedAuth): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return withCorsHeaders(new Response('Method not allowed', { status: 405 }));
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonRpcError(null, PARSE_ERROR, 'Request body is not valid JSON.');
    }
    if (Array.isArray(raw)) {
      return jsonRpcError(
        null,
        INVALID_REQUEST,
        'Batch requests are not supported; send one JSON-RPC message per request.'
      );
    }
    const parsed = jsonRpcEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      // Recover the id when it is well-typed so a client can correlate the error.
      const rawId = isRecord(raw) ? raw['id'] : undefined;
      const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
      return jsonRpcError(
        id,
        INVALID_REQUEST,
        'Expected a JSON-RPC 2.0 request with a string "method".'
      );
    }
    return handleRpcMessage(parsed.data, auth, deps);
  };
}

/**
 * The bearer challenge this worker names when the library authenticated the
 * request but the grant carries no Kilo credential (the user must reconnect).
 * Mirrors the library's RFC 9728 challenge so an MCP client rediscovers the
 * authorization server.
 */
function unauthorizedResponse(request: Request): Response {
  const url = new URL(request.url);
  const resourceMetadata = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
  return withCorsHeaders(
    new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: UNAUTHORIZED,
          message:
            'A valid Kilo MCP access token is required in the Authorization header. Reconnect the Kilo MCP server and sign in.',
        },
      }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer realm="OAuth", resource_metadata="${resourceMetadata}", error="invalid_token", scope="${MCP_SCOPE}"`,
        },
      }
    )
  );
}

/** The ExecutionContext the library hands the API handler carries the decrypted grant props. */
type McpApiContext = ExecutionContext & { props?: GrantProps };

/**
 * The `apiHandler` for `/mcp`. The OAuthProvider verifies the bearer and
 * decrypts the grant props before this runs, so identity comes entirely from
 * `ctx.props`. A grant with no Kilo token bound (a stale/foreign grant) is
 * rejected with the MCP 401 challenge and an anonymous auth_failure event.
 */
export const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const analytics = createMcpAnalytics({ env, ctx });
    const props = (ctx as McpApiContext).props;
    if (!props || typeof props.kiloToken !== 'string' || props.kiloToken.length === 0) {
      // Anonymous by construction: no Kilo user is bound, so the event must not
      // be attributed to a person ($process_person_profile: false).
      analytics.callRejected({ identity: null, reason: 'auth_failure' });
      return unauthorizedResponse(request);
    }
    const handler = createMcpHandler({
      catalog,
      webBaseUrl: env.WEB_BASE_URL,
      semanticCandidates: createSemanticCandidates(env),
      analytics,
    });
    return handler(request, forwardedAuthFromProps(props));
  },
} satisfies ExportedHandler<Env>;

/**
 * DCR guard (RFC 7591). The library hands the raw, untrusted client metadata to
 * this callback before storing the client: zod rejects a malformed body and a
 * declared `scope` this server does not issue is refused rather than
 * broadened. Public/loopback clients stay registerable (no
 * `disallowPublicClientRegistration`).
 */
export function clientRegistrationCallback(
  options: ClientRegistrationCallbackOptions
): ClientRegistrationCallbackResult | void {
  const parsed = clientRegistrationSchema.safeParse(options.clientMetadata);
  if (!parsed.success) {
    return {
      code: 'invalid_client_metadata',
      description: `Invalid client metadata: ${describeZodIssues(parsed.error)}`,
    };
  }
  const unsupported = scopeTokens(parsed.data.scope ?? '').filter(scope => scope !== MCP_SCOPE);
  if (unsupported.length > 0) {
    return {
      code: 'invalid_client_metadata',
      description: `Unsupported scope(s): ${unsupported.join(', ')}. This server supports only "${MCP_SCOPE}".`,
    };
  }
}

/**
 * Every non-/mcp path (including the browser-facing authorize UI) is owned by
 * the consent handler, rebuilt per request so its Durable-Object store and
 * analytics are bound to that request's env.
 */
const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env, ctx): Promise<Response> {
    const analytics = createMcpAnalytics({ env, ctx });
    const consent = createDefaultHandler({
      store: getKiloMcpOAuthStoreStub(env),
      webBaseUrl: env.WEB_BASE_URL,
      analytics,
    });
    const fetchHandler = consent.fetch;
    if (!fetchHandler) return new Response('Not found', { status: 404 });
    return fetchHandler(request, env, ctx);
  },
};

/**
 * The worker: `@cloudflare/workers-oauth-provider` owns the OAuth 2.1 protocol
 * endpoints (token, DCR, metadata) and the /mcp audience check; this module
 * supplies the /mcp JSON-RPC handler and the browser consent handler. Leaving
 * `resource`/`authorization_servers` unset makes the library derive the issuer
 * from the request origin, matching this worker's dynamic dev/prod issuer.
 */
const providerOptions: OAuthProviderOptions<Env> = {
  apiRoute: '/mcp',
  apiHandler,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: [MCP_SCOPE],
  accessTokenTTL: 3600,
  refreshTokenTTL: 2592000,
  resourceMetadata: {
    resource_name: 'Kilo MCP',
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
  },
  clientRegistrationCallback,
  tokenExchangeCallback: options => tokenExchangeCallback(options),
};

function fetchWithProvider(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const analytics = createMcpAnalytics({ env, ctx });
  const provider = new OAuthProvider<Env>({
    ...providerOptions,
    onError: error => onError(error, { analytics }),
  });
  return provider.fetch(request, env, ctx);
}

/**
 * All token exchanges use the existing named DO, not a per-Worker mutex.
 * The queue spans the provider's KV I/O without blocking consent RPCs or MCP.
 */
export class KiloMcpOAuthStore extends OAuthStore {
  private readonly forwardToken = createRefreshReuseHandler({
    store: this,
    revokeGrant: (grantId, userId) =>
      getOAuthApi(providerOptions, this.env).revokeGrant(grantId, userId),
  });

  fetch(request: Request): Promise<Response> {
    if (!isTokenRequest(request))
      return Promise.resolve(new Response('Not found', { status: 404 }));
    // The provider's token route never dispatches a handler or uses ctx beyond
    // our analytics waitUntil. The DO state supplies that request lifetime.
    const tokenContext: Pick<ExecutionContext, 'waitUntil' | 'props'> = this.ctx;
    return this.forwardToken(request, req =>
      fetchWithProvider(req, this.env, tokenContext as ExecutionContext)
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (isTokenRequest(request)) return getKiloMcpOAuthStoreStub(env).fetch(request);
    return fetchWithProvider(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
