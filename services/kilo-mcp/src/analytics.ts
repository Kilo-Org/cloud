/**
 * Server-side PostHog analytics for the kilo-MCP worker.
 *
 * Transport mirrors the repository's Cloudflare-Worker PostHog convention: a
 * direct `fetch` to the capture API with a 5s `AbortSignal.timeout`, no SDK and
 * no dependency (see services/kiloclaw/src/lib/posthog.ts and
 * services/security-auto-analysis/src/posthog.ts). Captures are scheduled
 * through `ExecutionContext.waitUntil` so they never block an MCP response,
 * and every public call is wrapped so analytics can never throw.
 *
 * Privacy: the builders accept identifiers, counts, durations, and error
 * classes only. Raw query text is reduced to a token count and a length bucket
 * by `queryShape`. Authenticated events carry `userId` and (when present)
 * `organizationId`; anonymous events set `$process_person_profile: false` so
 * PostHog creates no person row. No message content, prompt, token, cookie, or
 * credential is ever emitted.
 */
import { tokenize } from './search';
import { JsonRpcFailure } from './types';

const POSTHOG_CAPTURE_URL = 'https://us.i.posthog.com/i/v0/e/';
const POSTHOG_TIMEOUT_MS = 5_000;

/** distinct_id for events emitted without an authenticated identity. */
export const ANONYMOUS_DISTINCT_ID = 'kilo-mcp-anonymous';

/** The authenticated caller an event is bound to. */
export type AnalyticsIdentity = {
  kiloUserId: string;
  organizationId: string | null;
};

/** A pure, pre-transport analytics event. */
export type McpAnalyticsEvent = {
  event: string;
  identity: AnalyticsIdentity | null;
  properties: Record<string, unknown>;
};

/** Error classes `classifyToolError` can return. */
export type ToolErrorClass =
  | 'auth_failure'
  | 'unknown_path'
  | 'schema_invalid'
  | 'invalid_params'
  | 'unknown_tool'
  | 'upstream_unreachable'
  | 'upstream_error'
  | 'internal_error'
  | 'unknown';

/** Reasons a call is rejected before a tool result is produced. */
export type CallRejectedReason =
  | 'auth_failure'
  | 'unknown_path'
  | 'schema_invalid'
  | 'invalid_params';

/** Query length bucket; carries no user text. */
export type QueryCharBucket = '0' | '1-16' | '17-64' | '65-256' | '257+';

/** The query's shape only: token count and length bucket. */
export type QueryShape = {
  queryTokenCount: number;
  queryCharBucket: QueryCharBucket;
};

export type SessionStartedInput = {
  identity: AnalyticsIdentity | null;
  protocolVersion?: string;
  clientName?: string;
};

export type ToolCalledInput = {
  identity: AnalyticsIdentity | null;
  tool: string;
  path?: string;
  success: boolean;
  errorClass: string;
  latencyMs: number;
};

export type SearchPerformedInput = {
  identity: AnalyticsIdentity | null;
  hitCount: number;
  empty: boolean;
  queryTokenCount: number;
  queryCharBucket: QueryCharBucket;
  limit: number;
};

export type CallRejectedInput = {
  identity: AnalyticsIdentity | null;
  reason: CallRejectedReason;
  path?: string;
};

export type OAuthSignInPhase = 'started' | 'succeeded' | 'failed';

export type OAuthSignInInput = {
  identity: AnalyticsIdentity | null;
  phase: OAuthSignInPhase;
  clientId?: string;
  reason?: string;
};

/** `kilo_mcp_session_started`. */
export function sessionStartedEvent(input: SessionStartedInput): McpAnalyticsEvent {
  const properties: Record<string, unknown> = {};
  if (input.protocolVersion !== undefined) properties['protocolVersion'] = input.protocolVersion;
  if (input.clientName !== undefined) properties['clientName'] = input.clientName;
  return { event: 'kilo_mcp_session_started', identity: input.identity, properties };
}

/** `kilo_mcp_tool_called`. */
export function toolCalledEvent(input: ToolCalledInput): McpAnalyticsEvent {
  const properties: Record<string, unknown> = {
    tool: input.tool,
    success: input.success,
    errorClass: input.errorClass,
    latencyMs: input.latencyMs,
  };
  if (input.path !== undefined) properties['path'] = input.path;
  return { event: 'kilo_mcp_tool_called', identity: input.identity, properties };
}

/** `kilo_mcp_search_performed`. */
export function searchPerformedEvent(input: SearchPerformedInput): McpAnalyticsEvent {
  return {
    event: 'kilo_mcp_search_performed',
    identity: input.identity,
    properties: {
      hitCount: input.hitCount,
      empty: input.empty,
      queryTokenCount: input.queryTokenCount,
      queryCharBucket: input.queryCharBucket,
      limit: input.limit,
    },
  };
}

/** `kilo_mcp_call_rejected`. */
export function callRejectedEvent(input: CallRejectedInput): McpAnalyticsEvent {
  const properties: Record<string, unknown> = { reason: input.reason };
  if (input.path !== undefined) properties['path'] = input.path;
  return { event: 'kilo_mcp_call_rejected', identity: input.identity, properties };
}

const OAUTH_EVENT_BY_PHASE: Record<OAuthSignInPhase, string> = {
  started: 'kilo_mcp_oauth_sign_in_started',
  succeeded: 'kilo_mcp_oauth_sign_in_succeeded',
  failed: 'kilo_mcp_oauth_sign_in_failed',
};

/** `kilo_mcp_oauth_sign_in_{started,succeeded,failed}`. */
export function oauthSignInEvent(input: OAuthSignInInput): McpAnalyticsEvent {
  const properties: Record<string, unknown> = { phase: input.phase };
  if (input.clientId !== undefined) properties['clientId'] = input.clientId;
  if (input.reason !== undefined) properties['reason'] = input.reason;
  return { event: OAUTH_EVENT_BY_PHASE[input.phase], identity: input.identity, properties };
}

/**
 * Event properties plus the identity binding and the shared PostHog context.
 * Authenticated events get `userId` and, when non-null, `organizationId`;
 * anonymous events set `$process_person_profile: false` so no PostHog person
 * row is created.
 */
function captureProperties(event: McpAnalyticsEvent): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    ...event.properties,
    feature: 'kilo-mcp',
    $lib: 'kilo-mcp-worker',
  };
  if (event.identity) {
    properties['userId'] = event.identity.kiloUserId;
    if (event.identity.organizationId !== null) {
      properties['organizationId'] = event.identity.organizationId;
    }
  } else {
    properties['$process_person_profile'] = false;
  }
  return properties;
}

/** The exact PostHog capture request body. */
export type CapturePayload = {
  api_key: string;
  distinct_id: string;
  event: string;
  properties: Record<string, unknown>;
};

/** Build the exact capture body for an event. */
export function buildCapturePayload(event: McpAnalyticsEvent, apiKey: string): CapturePayload {
  return {
    api_key: apiKey,
    distinct_id: event.identity?.kiloUserId ?? ANONYMOUS_DISTINCT_ID,
    event: event.event,
    properties: captureProperties(event),
  };
}

/** Reduce a raw query to a token count and a length bucket; never the text. */
export function queryShape(query: string): QueryShape {
  const queryTokenCount = tokenize(query).length;
  const length = query.length;
  const queryCharBucket: QueryCharBucket =
    length === 0
      ? '0'
      : length <= 16
        ? '1-16'
        : length <= 64
          ? '17-64'
          : length <= 256
            ? '65-256'
            : '257+';
  return { queryTokenCount, queryCharBucket };
}

const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32000;

/**
 * Classify a tool failure into an allowlisted error class. Message content is
 * inspected, never emitted; the returned class is what reaches analytics (a
 * plain Error contributes only its `name`).
 */
export function classifyToolError(error: unknown): string {
  if (error instanceof JsonRpcFailure) {
    if (error.code === INVALID_PARAMS && error.message.startsWith('Unknown path')) {
      return 'unknown_path';
    }
    if (error.message.includes('published schema')) {
      return 'schema_invalid';
    }
    if (error.message.includes('Unknown tool')) {
      return 'unknown_tool';
    }
    if (error.code === INTERNAL_ERROR && error.data?.['retryable'] === true) {
      return 'upstream_unreachable';
    }
    if (error.code === INTERNAL_ERROR && typeof error.data?.['trpcCode'] === 'string') {
      return 'upstream_error';
    }
    if (error.code === INTERNAL_ERROR) {
      return 'internal_error';
    }
    return 'invalid_params';
  }
  if (error instanceof Error) {
    return error.name;
  }
  return 'unknown';
}

/** Injectable dependencies for `createMcpAnalytics`. */
export type McpAnalyticsDeps = {
  env: { NEXT_PUBLIC_POSTHOG_KEY?: string };
  ctx?: { waitUntil(promise: Promise<unknown>): void };
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

/** The five emit methods; each takes its builder's input shape. */
export type McpAnalytics = {
  sessionStarted(input: SessionStartedInput): void;
  toolCalled(input: ToolCalledInput): void;
  searchPerformed(input: SearchPerformedInput): void;
  callRejected(input: CallRejectedInput): void;
  oauthSignIn(input: OAuthSignInInput): void;
};

/**
 * POST one capture with a 5s timeout and consume the body. The fetch runs
 * inside an async function with a local try/catch so a `fetchImpl` that throws
 * synchronously, rejects, or times out can never surface.
 */
async function sendCapture(payload: CapturePayload, fetchImpl: typeof fetch): Promise<void> {
  try {
    const response = await fetchImpl(POSTHOG_CAPTURE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(POSTHOG_TIMEOUT_MS),
      body: JSON.stringify(payload),
    });
    // Consume the body so the Worker does not warn about a leaked response.
    await response.text().catch(() => '');
  } catch {
    // Best-effort: a failed capture must never surface to the caller.
  }
}

/**
 * Create the analytics emitter for one request. Every method always logs the
 * decisive local-proof line, then either stops (no key: consent / non-prod
 * gate) or schedules a capture through `waitUntil`. It can never throw.
 */
export function createMcpAnalytics(deps: McpAnalyticsDeps): McpAnalytics {
  const log = deps.log ?? console.log;
  const fetchImpl = deps.fetchImpl ?? fetch;

  function emit(event: McpAnalyticsEvent): void {
    try {
      const serialized = JSON.stringify(captureProperties(event)) ?? '{}';
      log(`[kilo-mcp] analytics ${event.event} ${serialized}`);
      const apiKey = deps.env.NEXT_PUBLIC_POSTHOG_KEY;
      if (!apiKey) return;
      const promise = sendCapture(buildCapturePayload(event, apiKey), fetchImpl).catch(() => {});
      if (deps.ctx) deps.ctx.waitUntil(promise);
      else void promise;
    } catch {
      // Analytics is best-effort and must never break an MCP response.
    }
  }

  return {
    sessionStarted: input => emit(sessionStartedEvent(input)),
    toolCalled: input => emit(toolCalledEvent(input)),
    searchPerformed: input => emit(searchPerformedEvent(input)),
    callRejected: input => emit(callRejectedEvent(input)),
    oauthSignIn: input => emit(oauthSignInEvent(input)),
  };
}
