import catalogJson from '../catalog.json';
import {
  classifyToolError,
  createMcpAnalytics,
  queryShape,
  type AnalyticsIdentity,
  type CallRejectedReason,
  type McpAnalytics,
} from './analytics';
import { authenticate } from './auth';
import { handleAuthorize } from './auth/authorize';
import { handleRegistration } from './auth/dcr';
import { AUTH_PATHS } from './auth/http';
import {
  handleAuthorizationServerMetadata,
  handleProtectedResourceMetadata,
  protectedResourceMetadataUrl,
} from './auth/metadata';
import { handleToken } from './auth/token';
import { callCatalogEndpoint } from './call';
import { getKiloMcpOAuthStoreStub, type OAuthStoreApi } from './store/oauth-store';
import { handlePairingStatus } from './oauth-pages/authorize-page';
import { handleOrgPicker } from './oauth-pages/org-picker';
import { DEFAULT_SEARCH_LIMIT, noSemanticCandidates, searchCatalog } from './search';
import { createSemanticCandidates } from './search-knn';
import { JsonRpcFailure, type Catalog, type ForwardedAuth, type SemanticCandidates } from './types';

/** The Durable Object class must stay exported from the entry module for wrangler. */
export { KiloMcpOAuthStore } from './store/oauth-store';

/** The bundled catalog dumped by apps/web/src/scripts/mcp-catalog (s1). */
const catalog = catalogJson as unknown as Catalog;

/** The token endpoint cannot mint unsigned tokens: fail loudly if unconfigured. */
function requireMcpTokenSecret(env: Env): string {
  if (!env.MCP_TOKEN_SECRET) {
    throw new Error('MCP_TOKEN_SECRET is not configured (wrangler secret put MCP_TOKEN_SECRET).');
  }
  return env.MCP_TOKEN_SECRET;
}

/** JSON-RPC 2.0 error codes (https://www.jsonrpc.org/specification). */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
/** Bearer token required before this slice's OAuth flow (s5/s6) lands. */
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
          maximum: 50,
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

type RpcMessage = {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
};

type McpHandlerDeps = {
  catalog: Catalog;
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
  /** Vectorize kNN hook; token-only search when omitted. */
  semanticCandidates?: SemanticCandidates;
  /**
   * MCP OAuth verification (s5) + enforcement (s6). When present, /mcp
   * accepts ONLY a bearer signed by this worker (signature/exp/iss/aud/jti
   * checked) and forwards the Kilo credential bound to the verified identity;
   * foreign bearers are rejected. Omitted in tests without the OAuth flow.
   */
  mcpAuth?: { tokenSecret: string; store: OAuthStoreApi };
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
 * The identity an event is bound to: present only when the bearer was verified
 * as this worker's MCP access token (s6). A caller-supplied header never
 * contributes — identity comes from the verified claims, never from the
 * request.
 */
function identity(auth: ForwardedAuth): AnalyticsIdentity | null {
  return auth.mcpIdentity
    ? { kiloUserId: auth.mcpIdentity.kiloUserId, organizationId: auth.mcpIdentity.organizationId }
    : null;
}

/** An MCP tools/call success payload. */
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  truncated?: true;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  auth: ForwardedAuth,
  deps: McpHandlerDeps,
  analytics: McpAnalytics,
  callerIdentity: AnalyticsIdentity | null
): Promise<ToolResult> {
  if (name === 'search') {
    const query = args['query'];
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new JsonRpcFailure(INVALID_PARAMS, 'search requires a non-empty string "query".');
    }
    const limit = args['limit'];
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit))) {
      throw new JsonRpcFailure(INVALID_PARAMS, 'search "limit" must be an integer.');
    }
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
    const path = args['path'];
    if (typeof path !== 'string' || path.length === 0) {
      throw new JsonRpcFailure(
        INVALID_PARAMS,
        'call requires a string "path" — run search first to find one.'
      );
    }
    const input = args['input'];
    if (input !== undefined && (typeof input !== 'object' || input === null)) {
      throw new JsonRpcFailure(INVALID_PARAMS, 'call "input" must be an object when present.');
    }
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
  message: RpcMessage,
  auth: ForwardedAuth,
  deps: McpHandlerDeps
): Promise<Response> {
  const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
  const method = typeof message.method === 'string' ? message.method : '';
  const analytics = deps.analytics ?? noopAnalytics;
  const callerIdentity = identity(auth);

  // Notifications carry no id and get no JSON-RPC response body.
  if (id === null && method.startsWith('notifications/')) {
    return withCorsHeaders(new Response(null, { status: 202 }));
  }

  try {
    switch (method) {
      case 'initialize': {
        const params = (message.params ?? {}) as {
          protocolVersion?: unknown;
          clientInfo?: unknown;
        };
        const protocolVersion =
          typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
        const clientInfo = (params.clientInfo ?? {}) as { name?: unknown };
        analytics.sessionStarted({
          identity: callerIdentity,
          protocolVersion,
          ...(typeof clientInfo.name === 'string' ? { clientName: clientInfo.name } : {}),
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
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof params.name !== 'string') {
          throw new JsonRpcFailure(INVALID_PARAMS, 'tools/call requires a string "name".');
        }
        const toolName = params.name;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
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
 * Exported for tests with an injectable catalog and web base URL; the default
 * fetch handler wires in the bundled catalog and env.
 */
export function createMcpHandler(deps: McpHandlerDeps) {
  return async function handleMcp(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return withCorsHeaders(new Response('Method not allowed', { status: 405 }));
    }

    const analytics = deps.analytics ?? noopAnalytics;

    // The issuer is always the URL this worker is reached at (dev vs prod
    // advertise themselves); the access token's `aud` is the `/mcp` resource.
    const issuer = new URL(request.url).origin;

    // s6 enforcement: with the OAuth deps present, /mcp accepts ONLY MCP
    // tokens signed by this worker; the forwarded bearer + org come from the
    // verified claims. Without them (unconfigured worker) the s2 passthrough
    // stays — see the fetch router for the binding check.
    const mcpAuth = deps.mcpAuth;
    const auth = await authenticate(
      request,
      mcpAuth
        ? {
            mcpToken: {
              tokenSecret: mcpAuth.tokenSecret,
              issuer,
              resource: `${issuer}/mcp`,
              isJtiRevoked: jti => mcpAuth.store.isJtiRevoked(jti),
            },
            resolveKiloToken: identity =>
              mcpAuth.store.getKiloToken(
                identity.kiloUserId,
                identity.clientId,
                new Date().toISOString()
              ),
          }
        : undefined
    );
    if (!auth) {
      // Anonymous by construction: no user has been verified, so the event
      // must not be bound to a person ($process_person_profile: false).
      analytics.callRejected({ identity: null, reason: 'auth_failure' });
      // HTTP 401 alongside a JSON-RPC error body; rejected before any
      // catalog lookup or upstream request. The challenge names this
      // server's protected-resource metadata (RFC 9728) so the MCP client
      // discovers the authorization server and runs the browser flow.
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
              'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${protectedResourceMetadataUrl(issuer)}"`,
            },
          }
        )
      );
    }

    let message: unknown;
    try {
      message = await request.json();
    } catch {
      return jsonRpcError(null, PARSE_ERROR, 'Request body is not valid JSON.');
    }
    if (Array.isArray(message)) {
      return jsonRpcError(
        null,
        INVALID_REQUEST,
        'Batch requests are not supported; send one JSON-RPC message per request.'
      );
    }
    const rpc = message as RpcMessage;
    if (typeof rpc !== 'object' || rpc === null || typeof rpc.method !== 'string') {
      return jsonRpcError(
        typeof rpc?.id === 'number' || typeof rpc?.id === 'string' ? rpc.id : null,
        INVALID_REQUEST,
        'Expected a JSON-RPC 2.0 request with a string "method".'
      );
    }
    return handleRpcMessage(rpc, auth, deps);
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const issuer = url.origin;
    // Best-effort PostHog emitter for this request; every emit is scheduled
    // through `ctx.waitUntil` so it never blocks or fails the response.
    const analytics = createMcpAnalytics({ env, ctx });

    switch (url.pathname) {
      case AUTH_PATHS.mcp: {
        // s6 enforcement: with the OAuth bindings present, /mcp accepts only
        // MCP tokens signed by this worker. Without them the worker cannot
        // verify anything, so it must not forward unverified bearers either —
        // POSTs are refused outright (transport replies stay available).
        if (!env.MCP_TOKEN_SECRET || !env.KILO_MCP_OAUTH_STORE) {
          if (request.method !== 'OPTIONS' && request.method !== 'GET') {
            return withCorsHeaders(
              new Response(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: null,
                  error: {
                    code: -32000,
                    message:
                      'This Kilo MCP deployment is missing its token-verification bindings (MCP_TOKEN_SECRET / OAuth store). Contact the operator.',
                  },
                }),
                { status: 503, headers: { 'Content-Type': 'application/json' } }
              )
            );
          }
          const transportOnly = createMcpHandler({
            catalog,
            webBaseUrl: env.WEB_BASE_URL,
            semanticCandidates: createSemanticCandidates(env),
            analytics,
          });
          return transportOnly(request);
        }
        const handler = createMcpHandler({
          catalog,
          webBaseUrl: env.WEB_BASE_URL,
          semanticCandidates: createSemanticCandidates(env),
          mcpAuth: { tokenSecret: env.MCP_TOKEN_SECRET, store: getKiloMcpOAuthStoreStub(env) },
          analytics,
        });
        return handler(request);
      }
      case AUTH_PATHS.authorizationServerMetadata:
      case AUTH_PATHS.authorizationServerMetadataScoped:
        return handleAuthorizationServerMetadata(request, { issuer });
      case AUTH_PATHS.protectedResourceMetadata:
      case AUTH_PATHS.protectedResourceMetadataScoped:
        return handleProtectedResourceMetadata(request, { issuer });
      case AUTH_PATHS.register:
        return handleRegistration(request, { store: getKiloMcpOAuthStoreStub(env) });
      case AUTH_PATHS.authorize: {
        // Built as a variable (not an inline literal) so the extra `analytics`
        // property is allowed until s3 adds the optional field to the handler
        // deps type. s3 emits OAuth sign-in events from this emitter.
        const authorizeDeps = {
          store: getKiloMcpOAuthStoreStub(env),
          webBaseUrl: env.WEB_BASE_URL,
          analytics,
        };
        return handleAuthorize(request, authorizeDeps);
      }
      case AUTH_PATHS.pairingStatus: {
        const pairingStatusDeps = {
          store: getKiloMcpOAuthStoreStub(env),
          webBaseUrl: env.WEB_BASE_URL,
          analytics,
        };
        return handlePairingStatus(request, pairingStatusDeps);
      }
      case AUTH_PATHS.orgPicker:
        return handleOrgPicker(request, {
          store: getKiloMcpOAuthStoreStub(env),
          webBaseUrl: env.WEB_BASE_URL,
        });
      case AUTH_PATHS.token: {
        const tokenDeps = {
          store: getKiloMcpOAuthStoreStub(env),
          tokenSecret: requireMcpTokenSecret(env),
          issuer,
          analytics,
        };
        return handleToken(request, tokenDeps);
      }
      default:
        return withCorsHeaders(new Response('Not found', { status: 404 }));
    }
  },
} satisfies ExportedHandler<Env>;
