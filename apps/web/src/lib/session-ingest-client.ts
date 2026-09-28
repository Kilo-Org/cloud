import 'server-only';

import { captureException } from '@sentry/nextjs';
import { z } from 'zod';
import { INTERNAL_API_SECRET, SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { ServiceFetchTimeoutError, fetchWithinBudget } from '@/lib/bounded-service-fetch';
import { generateBoundedInternalServiceToken } from '@/lib/tokens';
import { SESSION_INGEST_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import type { User } from '@kilocode/db/schema';
import {
  kiloSdkMessageHistorySchema,
  type KiloSdkMessageHistory,
} from '@kilocode/session-ingest-contracts';

// ---------------------------------------------------------------------------
// Zod schema (mirrors cloudflare-session-ingest SharedSessionSnapshotSchema)
// ---------------------------------------------------------------------------

// Mirrors SharedSessionSnapshotSchema from cloudflare-session-ingest/src/util/share-output.ts.
// Kept in sync manually (same pattern as cloud-agent-client.ts).
const SessionInfoSchema = z.looseObject({
  id: z.string().optional(),
  parentID: z.string().optional(),
  model: z
    .object({
      providerID: z.string(),
      id: z.string(),
      variant: z.string().optional(),
    })
    .optional(),
});

const SessionSnapshotSchema = z.object({
  info: SessionInfoSchema,
  messages: z.array(
    z.looseObject({
      info: z.looseObject({
        id: z.string(),
      }),
      parts: z.array(
        z.looseObject({
          id: z.string(),
        })
      ),
    })
  ),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Snapshot returned by the session-ingest export endpoint.
 * Contains the final compacted state of all messages — NOT streaming deltas.
 */
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

export type SessionMessage = SessionSnapshot['messages'][number];

// ---------------------------------------------------------------------------
// Bounded fetch
// ---------------------------------------------------------------------------

/**
 * Redact a request URL to an allow-listed route label for logging: the
 * pathname with its dynamic segment (session id or share token) replaced by a
 * placeholder, and never the query string.
 *
 * The route marker is matched anywhere in the pathname, not anchored to its
 * start: every call site concatenates `SESSION_INGEST_WORKER_URL` as-is
 * (`config.server.ts:479` returns the env value unchanged), so a configured
 * trailing slash or path prefix yields `//api/session/<id>/...` or
 * `/prefix/api/session/<id>/...`. Anchoring here would let the dynamic segment
 * through unredacted. The label is rebuilt from the matched route, so the
 * configured base — including any path prefix — never reaches the log. Anything
 * that is not an allow-listed route shape falls back to a constant, so an
 * unrecognised path can never emit a session id or share token.
 */
function redactedRouteForLog(requestUrl: string): string {
  try {
    const pathname = new URL(requestUrl).pathname;
    const sessionRoute = pathname.match(/\/api\/session\/[^/]+/);
    if (sessionRoute) {
      return `/api/session/:sessionId${pathname.slice(
        (sessionRoute.index ?? 0) + sessionRoute[0].length
      )}`;
    }
    const shareRoute = pathname.match(/\/session\/[^/]+/);
    if (shareRoute) {
      return `/session/:shareToken${pathname.slice(
        (shareRoute.index ?? 0) + shareRoute[0].length
      )}`;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Bound one session-ingest worker fetch with the shared control-plane upstream
 * budget.
 *
 * A worker that never answers rejects with `ServiceFetchTimeoutError` inside
 * `CONTROL_PLANE_UPSTREAM_BUDGET_MS` (strictly under the mobile app's 15s
 * `CONTROL_PLANE_DEADLINE_MS`) instead of holding the calling control-plane
 * procedure open until the client deadline fires or the gateway answers 504.
 * The timeout keeps the module's existing failure shape: every call site
 * already propagates a transport failure to its router, which maps it to an
 * `INTERNAL_SERVER_ERROR` the mobile client renders as its existing retryable
 * state — never a new non-retryable one.
 *
 * On a budget expiry exactly one allow-listed line is emitted. It carries the
 * redacted route, the elapsed time and a fixed outcome — never the
 * Authorization header, the internal-service token, the session id, the share
 * token or a query string.
 */
async function fetchSessionIngest(requestUrl: string, init: RequestInit = {}): Promise<Response> {
  const startedAt = Date.now();
  try {
    return await fetchWithinBudget(requestUrl, init);
  } catch (error) {
    if (error instanceof ServiceFetchTimeoutError) {
      console.log(
        JSON.stringify({
          type: 'session_ingest_timeout',
          route: redactedRouteForLog(requestUrl),
          durationMs: Date.now() - startedAt,
          outcome: 'timeout',
        })
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the session snapshot from the session-ingest service.
 *
 * Uses a short-lived internal service token (1h expiry, no User object needed).
 *
 * @returns The full snapshot (info + messages), or null if the session was not found.
 */
export async function fetchSessionSnapshot(
  sessionId: string,
  userId: string
): Promise<SessionSnapshot | null> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }

  const token = generateBoundedInternalServiceToken(userId, {
    audience: SESSION_INGEST_AUDIENCE,
    expiresIn: 60 * 60,
  });
  const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(sessionId)}/export`;

  const response = await fetchSessionIngest(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const error = new Error(
      `Session ingest export failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'export' },
      extra: { sessionId, status: response.status },
    });
    throw error;
  }

  return SessionSnapshotSchema.parse(await response.json());
}

/**
 * Convenience wrapper: fetch only the messages array for a session.
 * Accepts a full User object for compatibility with tRPC endpoint callers.
 */
export async function fetchSessionMessages(
  sessionId: string,
  user: User
): Promise<SessionMessage[] | null> {
  const snapshot = await fetchSessionSnapshot(sessionId, user.id);
  return snapshot?.messages ?? null;
}

// ---------------------------------------------------------------------------
// Paginated authorized session-message history
// ---------------------------------------------------------------------------

const SessionMessagesPageResponseSchema = z.object({
  success: z.literal(true),
  kiloSessionId: z.string().min(1),
  history: kiloSdkMessageHistorySchema.nullable(),
  // Session-level metadata (records keyed by `kilo.<feature>`, e.g.
  // `kilo.goal`). Optional so an older worker response stays parseable.
  sessionMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type SessionMessagesPageOptions = {
  /** Bounded by the worker's shared maximum (100). Mobile default is 50. */
  limit?: number;
  /** Opaque cursor returned by a previous page; requires a positive limit. */
  before?: string;
};

export type SessionMessagesPageResult = {
  kiloSessionId: string;
  history: KiloSdkMessageHistory | null;
  /** Session-level metadata from the ingest snapshot, when available. */
  sessionMetadata?: Record<string, unknown> | null;
  watermarkEventId?: number | null;
};

/**
 * Fetch a bounded page of persisted SDK messages for any Kilo session the
 * user owns. Mirrors the access-checked RPC the worker exposes via service
 * binding; returns `null` for sessions the user cannot read so the tRPC
 * router can surface a stable `NOT_FOUND`. Typed failure outcomes
 * (`retryable_failure`, `too_large`, `invalid_data`) are passed through
 * verbatim so the caller can distinguish retryable from non-retryable
 * failures without inferring retry semantics client-side.
 */
export async function fetchSessionMessagesPage(
  sessionId: string,
  userId: string,
  options: SessionMessagesPageOptions
): Promise<SessionMessagesPageResult | null> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }

  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set('limit', String(options.limit));
  }
  if (options.before !== undefined) {
    params.set('before', options.before);
  }

  const query = params.toString();
  const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(sessionId)}/messages${
    query ? `?${query}` : ''
  }`;

  const token = generateBoundedInternalServiceToken(userId, {
    audience: SESSION_INGEST_AUDIENCE,
    expiresIn: 60 * 60,
  });
  const response = await fetchSessionIngest(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const error = new Error(
      `Session ingest messages page failed: ${response.status} ${response.statusText}${
        errorText ? ` - ${errorText}` : ''
      }`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'messagesPage' },
      extra: { sessionId, status: response.status },
    });
    throw error;
  }

  const parsed = SessionMessagesPageResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    const error = new Error(
      `Session ingest messages page returned an unexpected response: ${parsed.error.message}`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'messagesPage' },
      extra: { sessionId, issues: parsed.error.issues },
    });
    throw error;
  }

  return {
    kiloSessionId: parsed.data.kiloSessionId,
    history: parsed.data.history,
    ...(parsed.data.sessionMetadata === undefined
      ? {}
      : { sessionMetadata: parsed.data.sessionMetadata }),
  };
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

const ShareResponseSchema = z
  .object({
    success: z.literal(true),
    share_token: z.string().min(1),
  })
  .strict();

const SharedSessionMetadataResponseSchema = z
  .object({
    success: z.literal(true),
    title: z.string().nullable(),
    owner_name: z.string().nullable(),
    git_url: z.string().nullable().optional(),
    git_branch: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
  })
  .strict();

/**
 * Share a session via the session-ingest worker.
 *
 * Calls POST /session/:sessionId/share which is idempotent — if the session
 * already has an active share generation, the existing one is reused.
 *
 * @returns The opaque JWT used to construct the /s/{share_token} share URL.
 */
export async function shareSession(
  sessionId: string,
  userId: string
): Promise<{ share_token: string }> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }

  const token = generateBoundedInternalServiceToken(userId, {
    audience: SESSION_INGEST_AUDIENCE,
    expiresIn: 60 * 60,
  });
  const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(sessionId)}/share`;

  const response = await fetchSessionIngest(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 404) {
    throw new Error('Session not found');
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const error = new Error(
      `Session ingest share failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'share' },
      extra: { sessionId, status: response.status },
    });
    throw error;
  }

  const body = ShareResponseSchema.parse(await response.json());
  return { share_token: body.share_token };
}

/**
 * Revoke a session's public share link via the session-ingest worker.
 *
 * Calls POST /session/:sessionId/unshare which clears `public_id`.
 * Owner-only on the worker; a missing or inaccessible session is 404.
 */
export async function unshareSession(sessionId: string, userId: string): Promise<void> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }

  const token = generateBoundedInternalServiceToken(userId, {
    audience: SESSION_INGEST_AUDIENCE,
    expiresIn: 60 * 60,
  });
  const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(sessionId)}/unshare`;

  const response = await fetchSessionIngest(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 404) {
    throw new Error('Session not found');
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const error = new Error(
      `Session ingest unshare failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'unshare' },
      extra: { sessionId, status: response.status },
    });
    throw error;
  }
}

export type SharedSessionMetadata = {
  title: string | null;
  ownerName: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  createdAt: string | null;
};

/**
 * Resolve the metadata for a public session share token without downloading
 * the session snapshot. The token is intentionally never included in errors
 * or Sentry context.
 */
export async function fetchSharedSessionMetadata(
  shareToken: string
): Promise<SharedSessionMetadata | null> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }

  const url = `${SESSION_INGEST_WORKER_URL}/session/${encodeURIComponent(shareToken)}/metadata`;
  const response = await fetchSessionIngest(url, { cache: 'no-store' });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = new Error(
      `Session ingest metadata failed: ${response.status} ${response.statusText}`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'metadata' },
      extra: { status: response.status },
    });
    throw error;
  }

  const parsed = SharedSessionMetadataResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  if (!parsed.success) {
    const error = new Error('Session ingest metadata response was malformed');
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'metadata' },
      extra: { status: response.status, issues: parsed.error.issues },
    });
    throw error;
  }

  return {
    title: parsed.data.title,
    ownerName: parsed.data.owner_name,
    gitUrl: parsed.data.git_url ?? null,
    gitBranch: parsed.data.git_branch ?? null,
    createdAt: parsed.data.created_at ?? null,
  };
}

/**
 * Fetch the public session snapshot for a share token. The token is
 * intentionally never included in errors or Sentry context.
 */
export async function fetchSharedSessionSnapshot(
  shareToken: string
): Promise<SessionSnapshot | null> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }

  const url = `${SESSION_INGEST_WORKER_URL}/session/${encodeURIComponent(shareToken)}`;
  const response = await fetchSessionIngest(url, { cache: 'no-store' });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = new Error(
      `Session ingest snapshot failed: ${response.status} ${response.statusText}`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'shared-snapshot' },
      extra: { status: response.status },
    });
    throw error;
  }

  const parsed = SessionSnapshotSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    const error = new Error('Session ingest snapshot response was malformed');
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'shared-snapshot' },
      extra: { status: response.status, issues: parsed.error.issues },
    });
    throw error;
  }

  return parsed.data;
}

// ---------------------------------------------------------------------------
// Authorization cache invalidation
// ---------------------------------------------------------------------------

export async function invalidateOrganizationSessionAccess(
  kiloUserId: string,
  organizationId: string
): Promise<void> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }
  if (!INTERNAL_API_SECRET) {
    throw new Error('INTERNAL_API_SECRET is not configured');
  }

  const response = await fetchSessionIngest(
    `${SESSION_INGEST_WORKER_URL}/internal/session-access/invalidate`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Secret': INTERNAL_API_SECRET,
      },
      body: JSON.stringify({ kiloUserId, organizationId }),
      // Caller deadline, composed with the shared upstream budget by
      // `fetchWithinBudget`; the shorter budget wins, so a hung worker cannot
      // hold this past `CONTROL_PLANE_UPSTREAM_BUDGET_MS`.
      signal: AbortSignal.timeout(30_000),
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const error = new Error(
      `Session access invalidation failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'invalidate-session-access' },
      extra: { kiloUserId, organizationId, status: response.status },
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a session via the session-ingest worker.
 *
 * The ingest worker owns all DB deletion (recursive child sessions) and
 * ingest DO / cache cleanup. Returns void on success.
 */
export async function deleteSession(sessionId: string, userId: string): Promise<void> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }

  const token = generateBoundedInternalServiceToken(userId, {
    audience: SESSION_INGEST_AUDIENCE,
    expiresIn: 60 * 60,
  });
  const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(sessionId)}`;

  const response = await fetchSessionIngest(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 404) {
    // Session already deleted or was never ingested — treat as success (idempotent delete).
    return;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const error = new Error(
      `Session ingest delete failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'delete' },
      extra: { sessionId, status: response.status },
    });
    throw error;
  }
}
