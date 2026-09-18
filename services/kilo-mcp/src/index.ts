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
import {
  callCatalogEndpoint,
  executeProtectedCall,
  MAX_RESULT_BYTES,
  requestProtectedCall,
} from './call';
import { createDefaultHandler } from './oauth/consent';
import { fetchUserIsAdmin } from './oauth/kilo-pairing';
import { onError, tokenExchangeCallback } from './oauth/provider-hooks';
import { createRefreshReuseHandler, isTokenRequest } from './oauth/refresh-reuse';
import {
  CLIENT_REGISTRATION_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from './oauth/session-lifetime';
import {
  callArgsSchema,
  clientRegistrationSchema,
  initializeParamsSchema,
  jsonRpcEnvelopeSchema,
  searchArgsSchema,
  submitOtpArgsSchema,
  toolsCallParamsSchema,
  type JsonRpcEnvelope,
} from './schemas';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  noSemanticCandidates,
  searchCatalogDetailed,
} from './search';
import { createSemanticCandidates } from './search-knn';
import { getKiloMcpOAuthStoreStub, KiloMcpOAuthStore as OAuthStore } from './store/oauth-store';
import {
  JsonRpcFailure,
  type Catalog,
  type ForwardedAuth,
  type GrantProps,
  type OtpSubmitOutcome,
  type ProtectedRequestsApi,
  type SearchResult,
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
/** A local or upstream failure that is not the caller's fault (retryable when marked so). */
const INTERNAL_ERROR = -32000;
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
const PUBLISHED_TOOL_NAMES = new Set(['search', 'call', 'call_protected', 'submit_otp']);

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
      'Search the Kilo API catalog for endpoints that match a task. ALWAYS run search first: the call tool only accepts paths this catalog publishes, and search returns the path, summary, and input schema you need for the call. Every result carries a kind: "query" reads data, "mutation" changes it.',
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
      'Call a Kilo API endpoint by its catalog path. Run search first to find a valid path and its input schema — paths outside the catalog and inputs that violate the published schema are rejected before any request is made. A call to a "mutation" path changes data, so call one only when the user asked for that change; if such a call fails with an ambiguous transport error, check the current state before retrying.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'A catalog endpoint path returned by search, e.g. "organizations.list".',
        },
        input: {
          description:
            'Arguments matching the endpoint input schema from search. Usually an object, but some endpoints take a scalar or array — pass exactly the value the schema describes. Omit for endpoints that take no input.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
] as const;

/**
 * The two tools published only to an opted-in admin connection. `call_protected`
 * records a reviewed admin or debug call; `submit_otp` runs it once the user's
 * authenticator code is accepted. The payload is fixed by `call_protected`, so
 * `submit_otp` carries no path and no input.
 */
const PROTECTED_TOOLS = [
  {
    name: 'call_protected',
    description:
      'Call an admin or debug Kilo API endpoint with OTP approval. This does NOT run the endpoint: it validates the input, records the call exactly as submitted, and returns a request_id and an expiry. Ask the user to read the current code from their authenticator app, then call submit_otp with that request_id and that code. The endpoint and payload are fixed once this returns, and the call runs at most once, when the code is accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'An admin or debug catalog endpoint path returned by search, e.g. "organizations.admin.getMetrics". The call tool refuses these paths.',
        },
        input: {
          description:
            'Arguments matching the endpoint input schema from search. Usually an object, but some endpoints take a scalar or array — pass exactly the value the schema describes. Omit for endpoints that take no input.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_otp',
    description:
      "Approve and run the admin or debug call that call_protected recorded. The code comes from the user's authenticator app, never from the model or the transcript. This tool takes only the request_id from call_protected and the current otp: the endpoint and payload were fixed when call_protected returned and cannot change here.",
    inputSchema: {
      type: 'object',
      properties: {
        request_id: {
          type: 'string',
          description: 'The request_id that call_protected returned.',
        },
        otp: {
          type: 'string',
          description:
            'The current one-time code the user reads from their authenticator app for this Kilo account.',
        },
      },
      required: ['request_id', 'otp'],
      additionalProperties: false,
    },
  },
] as const;

/**
 * Whether this grant may use the OTP-protected admin and debug tools. Fail-closed
 * on every leg: the admin opt-in, the live admin eligibility recorded on the
 * grant, and a non-empty per-connection id the pending request binds to. A
 * pre-amendment grant (no `sessionId`) is never eligible.
 */
export function canUseProtectedActions(auth: ForwardedAuth): boolean {
  return (
    auth.adminEnabled === true &&
    auth.adminEligible === true &&
    typeof auth.sessionId === 'string' &&
    auth.sessionId.length > 0
  );
}

/** The ordinary unknown-tool refusal; an unpublished name is never disclosed. */
function unknownTool(name: string): JsonRpcFailure {
  return new JsonRpcFailure(
    INVALID_PARAMS,
    `Unknown tool "${name}". Available tools: search, call.`
  );
}

type McpHandlerDeps = {
  catalog: Catalog;
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
  /**
   * The pending protected-request store (o2). A guarded call without it is
   * refused before anything runs: never fail open.
   */
  protectedRequests?: ProtectedRequestsApi;
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

/**
 * The raw Kilo token inside the grant's `Authorization` header value. The
 * admin re-check calls `fetchUserIsAdmin`, which forms its own `Bearer …`
 * header, so the grant's already-prefixed value is unwrapped here. Never log or
 * echo the result.
 */
function grantKiloToken(authorization: string): string {
  return authorization.replace(/^Bearer\s+/i, '');
}

/** An MCP tools/call success payload. */
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  truncated?: true;
};

/**
 * Wrap a capped serialized payload as a tool result, marking it truncated when
 * the cap cut it so the client knows the text is incomplete.
 */
function toolResult(outcome: { text: string; truncated: boolean }): ToolResult {
  return {
    content: [{ type: 'text', text: outcome.text }],
    ...(outcome.truncated ? { truncated: true as const } : {}),
  };
}

/** UTF-8 byte length, the unit `MAX_RESULT_BYTES` measures. */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Serialize search hits so an over-cap payload is still valid JSON.
 *
 * Every hit carries its published input schema, so a 50-row result can pass the
 * tool-result cap. Cutting the serialized text at a byte boundary (what
 * `serializeWithCap` does for the call tool's opaque upstream data) leaves the
 * agent with unparseable JSON and no count of what was dropped. Drop hits from
 * the end instead — the ranking already puts the best matches first — and say
 * in the payload how many were dropped, so nothing is lost silently.
 */
function cappedSearchResults(results: SearchResult[]): { text: string; truncated: boolean } {
  const full = JSON.stringify({ results });
  if (utf8ByteLength(full) <= MAX_RESULT_BYTES) return { text: full, truncated: false };
  for (let kept = results.length - 1; kept >= 0; kept -= 1) {
    const dropped = results.length - kept;
    const text = JSON.stringify({
      results: results.slice(0, kept),
      truncated: true,
      message: `Dropped ${dropped} of ${results.length} results to stay within the ${MAX_RESULT_BYTES}-byte tool-result cap. Use a narrower query or a lower "limit" to see them.`,
    });
    if (utf8ByteLength(text) <= MAX_RESULT_BYTES) return { text, truncated: true };
  }
  // Unreachable in practice: an empty result list with the drop notice is far
  // under the cap.
  return { text: JSON.stringify({ results: [], truncated: true }), truncated: true };
}

/**
 * The longest piece of a caller's search query echoed back in the empty-results
 * payload. `searchArgsSchema` gives `query` no length bound, so echoing it
 * verbatim could push the payload past `MAX_RESULT_BYTES`, and the generic cap
 * would cut the structured payload mid-token and leave unparseable JSON. A
 * bounded echo keeps the recovery payload valid JSON and inside the cap.
 */
const MAX_ECHOED_QUERY_CHARACTERS = 200;

/** Trim a query and bound its length on code-point boundaries for the echo. */
function boundedQueryEcho(query: string): string {
  const trimmed = query.trim();
  const codePoints = [...trimmed];
  if (codePoints.length <= MAX_ECHOED_QUERY_CHARACTERS) return trimmed;
  return `${codePoints.slice(0, MAX_ECHOED_QUERY_CHARACTERS).join('')}…`;
}

/** JSON object guard used only to recover the JSON-RPC `id` from a malformed envelope. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The refusal a `submit_otp` caller sees for a request it can no longer submit.
 * `gone` is the single uniform answer for an unknown id, another session's id
 * and a used request — it names no path, kind, client or owner, so enumerating
 * ids learns nothing. The owning connection, which already holds the id, gets
 * the specific `expired` or `invalidated` reason instead.
 */
function staleProtectedRequest(status: 'gone' | 'expired' | 'invalidated'): JsonRpcFailure {
  switch (status) {
    case 'expired':
      return new JsonRpcFailure(
        INVALID_PARAMS,
        'This request expired. Start a new admin or debug call with call_protected.'
      );
    case 'invalidated':
      return new JsonRpcFailure(
        INVALID_PARAMS,
        'This request was cancelled after too many incorrect codes. Start a new admin or debug call with call_protected.'
      );
    case 'gone':
      return new JsonRpcFailure(
        INVALID_PARAMS,
        'This request is no longer pending. Start a new admin or debug call with call_protected.'
      );
  }
}

/**
 * The wait an account-wide wrong-code lockout names, rounded up to whole
 * minutes so the refusal always reads as a duration. Safe to surface: it
 * describes the caller's own account, not a secret.
 */
function formatLockoutWait(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * The account-wide wrong-code lockout refusal. The gate is scoped to the
 * authenticator, so minting a fresh `call_protected` request cannot reset it;
 * the same copy serves the peek pre-check and the claim outcome.
 */
function lockedRefusal(retryAfterSeconds: number): JsonRpcFailure {
  return new JsonRpcFailure(
    INVALID_PARAMS,
    `Too many incorrect codes were submitted for this Kilo account. Try again in ${formatLockoutWait(
      retryAfterSeconds
    )}, then start a new admin or debug call with call_protected.`
  );
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
    // One pass yields the rows and whether the guarded gate withheld a match, so
    // the empty-state answer below needs no second search: an opted-in grant
    // withholds nothing, and a query with no match anywhere reports `false`.
    const { results, hiddenGuardedMatches } = await searchCatalogDetailed(query, {
      catalog: deps.catalog,
      limit,
      semanticCandidates: deps.semanticCandidates ?? noSemanticCandidates,
      // Fail-closed: only a grant that ticked the admin opt-in sees admin or
      // debug rows.
      includeGuarded: auth.adminEnabled === true,
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
      // Empty state, not an error: tell the agent how to recover. A query whose
      // only matches are guarded rows is NOT a bad query: the catalog matches,
      // the guarded gate hid the rows for this connection. That signal came from
      // the single search pass above, so no second embedding or vector lookup
      // runs while the user is already waiting on an empty answer. Only an admin
      // is told the endpoints exist — a non-admin gets no admin/debug trace.
      // The echoed query is bounded before serialization — never passed to the
      // byte cap, which would cut the structured payload into invalid JSON.
      const message = `No endpoints matched "${boundedQueryEcho(query)}". Refine your query: use fewer or different keywords, or describe the task in plain language.${
        hiddenGuardedMatches && auth.adminEligible === true
          ? ' Some endpoints matching this query are admin or debug endpoints and are hidden for this connection. If you are a Kilo admin, reconnect the Kilo MCP server and tick "Enable admin and debug actions" at sign-in to allow them; admin and debug calls then need a code from your authenticator app.'
          : ''
      }`;
      return toolResult({ text: JSON.stringify({ results: [], message }), truncated: false });
    }
    // Every hit carries its published input schema, and a 50-row result can
    // exceed the tool-result cap: drop the lowest-ranked hits so the payload
    // stays parseable JSON and names how many were dropped.
    return toolResult(cappedSearchResults(results));
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
    return toolResult(outcome);
  }
  if (name === 'call_protected') {
    // A connection without the opt-in, the live admin eligibility and a
    // sessionId never learns these tools exist: the same unknown-tool answer as
    // any unpublished name.
    if (!canUseProtectedActions(auth)) {
      throw unknownTool(name);
    }
    const parsed = callArgsSchema.safeParse(args);
    if (!parsed.success) {
      throw new JsonRpcFailure(
        INVALID_PARAMS,
        `Invalid call_protected arguments: ${describeZodIssues(parsed.error)}`
      );
    }
    const { path, input } = parsed.data;
    const outcome = await requestProtectedCall({
      catalog: deps.catalog,
      path,
      input,
      auth,
      ...(deps.protectedRequests ? { requests: deps.protectedRequests } : {}),
      webBaseUrl: deps.webBaseUrl,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    return {
      content: [{ type: 'text', text: outcome.text }],
      ...(outcome.truncated ? { truncated: true as const } : {}),
    };
  }
  if (name === 'submit_otp') {
    if (!canUseProtectedActions(auth)) {
      throw unknownTool(name);
    }
    const parsed = submitOtpArgsSchema.safeParse(args);
    if (!parsed.success) {
      throw new JsonRpcFailure(
        INVALID_PARAMS,
        `Invalid submit_otp arguments: ${describeZodIssues(parsed.error)}`
      );
    }
    const { request_id, otp } = parsed.data;
    const requests = deps.protectedRequests;
    const sessionId = auth.sessionId;
    if (!requests || typeof sessionId !== 'string' || sessionId.length === 0) {
      // Fail-closed: without the store there is no pending request to check or
      // claim, so an admin or debug call can never run.
      throw new JsonRpcFailure(
        INTERNAL_ERROR,
        `Could not check this admin or debug request for "${request_id}". Retry; if it keeps failing, reconnect the Kilo MCP server.`,
        { retryable: true }
      );
    }

    const nowIso = new Date().toISOString();
    let outcome: OtpSubmitOutcome;
    try {
      // `gone` covers an unknown id, another session's id and a used row with
      // one uniform answer that names no path, kind or owner; the owning
      // connection's expired/cancelled request gets its own refusal here,
      // before the live admin re-check below (a stale request never reaches it).
      const peek = await requests.peekProtectedRequest(request_id, sessionId, nowIso);
      if (peek.status === 'locked') {
        throw lockedRefusal(peek.retryAfterSeconds);
      }
      if (peek.status !== 'pending') {
        throw staleProtectedRequest(peek.status);
      }
      // Re-derive admin from the live user.getMe with the grant's Kilo bearer:
      // an admin who lost the role cannot execute an already-pending request.
      // A check that cannot be reached is retryable, never a pass.
      let isAdmin: boolean;
      try {
        isAdmin = await fetchUserIsAdmin(
          {
            webBaseUrl: deps.webBaseUrl,
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          },
          grantKiloToken(auth.authorization)
        );
      } catch {
        throw new JsonRpcFailure(
          INTERNAL_ERROR,
          'Could not check admin access for this admin or debug call. Retry; if it keeps failing, reconnect the Kilo MCP server.',
          { retryable: true }
        );
      }
      if (!isAdmin) {
        throw new JsonRpcFailure(
          INVALID_PARAMS,
          'Your Kilo account does not have admin access, so this admin or debug call cannot run. Reconnect the Kilo MCP server if that is unexpected.'
        );
      }
      outcome = await requests.verifyOtpAndClaim({
        id: request_id,
        sessionId,
        kiloUserId: auth.kiloUserId,
        code: otp,
        nowIso,
      });
    } catch (error) {
      if (error instanceof JsonRpcFailure) throw error;
      // A store failure is a local refusal: the code never reaches a message.
      throw new JsonRpcFailure(
        INTERNAL_ERROR,
        'Could not use this admin or debug request. Retry; if it keeps failing, reconnect the Kilo MCP server.',
        { retryable: true }
      );
    }

    switch (outcome.status) {
      case 'not_pending':
        throw staleProtectedRequest('gone');
      case 'expired':
        throw staleProtectedRequest('expired');
      case 'invalidated':
        throw staleProtectedRequest('invalidated');
      case 'bad_code':
        throw new JsonRpcFailure(
          INVALID_PARAMS,
          `That code is not valid. Check your authenticator app and try again. ${outcome.attemptsRemaining} attempts remaining.`
        );
      case 'reused_code':
        throw new JsonRpcFailure(
          INVALID_PARAMS,
          'That code was already used. Ask the user for the next code from their authenticator app, then submit it again.'
        );
      case 'no_authenticator':
        throw new JsonRpcFailure(
          INVALID_PARAMS,
          'No authenticator is registered for this Kilo account. Reconnect the Kilo MCP server and add your authenticator at sign-in.'
        );
      case 'locked':
        // The gate is account-wide, so a fresh call_protected cannot reset it.
        // Naming the wait lets the agent schedule the retry instead of guessing.
        throw lockedRefusal(outcome.retryAfterSeconds);
      case 'ok': {
        // The payload was fixed by call_protected and re-validated against the
        // published schema; this is the single upstream request for it.
        const result = await executeProtectedCall({
          catalog: deps.catalog,
          path: outcome.path,
          inputJson: outcome.inputJson,
          auth,
          webBaseUrl: deps.webBaseUrl,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
        return {
          content: [{ type: 'text', text: result.text }],
          ...(result.truncated ? { truncated: true as const } : {}),
        };
      }
    }
  }
  throw unknownTool(name);
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
          instructions: canUseProtectedActions(auth)
            ? 'This server exposes the Kilo API through two tools: search (find catalog endpoints) and call (invoke one by path). Search before every call. Each result carries a kind: "query" reads data, "mutation" changes it. Call a mutation path only when the user asked for that change, and if it fails with an ambiguous transport error, check the current state before retrying. This connection may also run admin and debug endpoints: use call_protected to submit one, then submit_otp with the code the user reads from their authenticator app to approve it. The endpoint and payload are fixed once call_protected returns.'
            : 'This server exposes the Kilo API through two tools: search (find catalog endpoints) and call (invoke one by path). Search before every call. Each result carries a kind: "query" reads data, "mutation" changes it. Call a mutation path only when the user asked for that change, and if it fails with an ambiguous transport error, check the current state before retrying.',
        });
      }
      case 'ping':
        return jsonRpcResult(id ?? 0, {});
      case 'tools/list':
        return jsonRpcResult(id ?? 0, {
          tools: canUseProtectedActions(auth) ? [...TOOLS, ...PROTECTED_TOOLS] : TOOLS,
        });
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
    // The pending protected requests live in the worker's existing DO (o2).
    // Resolve it only when the binding is present so a handler built without one
    // still answers every non-guarded call; the protected tools then fail closed
    // rather than running a guarded call unapproved.
    const protectedRequests = env.KILO_MCP_OAUTH_STORE ? getKiloMcpOAuthStoreStub(env) : undefined;
    const handler = createMcpHandler({
      catalog,
      webBaseUrl: env.WEB_BASE_URL,
      semanticCandidates: createSemanticCandidates(env),
      analytics,
      ...(protectedRequests ? { protectedRequests } : {}),
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
  // Session lifetime policy lives in ./oauth/session-lifetime: one year, with
  // the DCR record outliving the grant so a lapsed session re-authorizes.
  refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
  clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,
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
