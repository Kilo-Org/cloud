import { type MobileRouter } from '@kilocode/trpc/mobile';
import { createTRPCClient, httpBatchLink, httpLink, splitLink } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import { CONTROL_PLANE_DEADLINE_MS, withDeadline } from '@kilocode/event-service';
import * as SecureStore from '@/lib/auth/secure-store';

import { API_BASE_URL, E2E_LATENCY_MESSAGES_MS, E2E_LATENCY_SESSION_MS } from '@/lib/config';
import { performRefresh, REFRESH_MARGIN_MS } from '@/lib/auth/credentials';
import { buildAuthHeaders } from '@/lib/auth/auth-header';
import { buildClientMetadataHeaders } from '@/lib/client-metadata';
import { shouldRefreshBeforeRequest } from '@/lib/auth/native-auth-contract';
import { createNetworkErrorFetch, readTrpcResponseError } from '@/lib/telemetry/network-errors';
import { postLatencyBatch } from '@/lib/telemetry/latency-ingest';
import { createLatencyBuffer, createLatencyFetch } from '@/lib/telemetry/request-latency';
import {
  getActiveToken,
  getActiveTokenSnapshot,
  getAuthTokenForRequest,
  publishActiveTokenExpiry,
} from '@/lib/auth/token-owner';
import { TOKEN_EXPIRES_AT_KEY } from '@/lib/storage-keys';

export const { TRPCProvider, useTRPC } = createTRPCContext<MobileRouter>();

const trpcUrl = `${API_BASE_URL}/api/trpc`;

/**
 * Procedures that leave the tRPC batch and get their own HTTP call. Source:
 * Axiom dashboard d35acea0-747f-4200-9d04-847a2e30a554, panel "Unbatch
 * candidates — caller-seconds lost", read 2026-09-18T02:48Z: user.getMe
 * 3,475 batches / 5,836 caller-seconds lost, activeSessions.list 2,129,
 * cliSessionsV2.getSessionMessagesPage 1,597.
 */
export const UNBATCHED_PROCEDURES = new Set([
  'user.getMe',
  'activeSessions.list',
  'cliSessionsV2.getSessionMessagesPage',
]);

/**
 * E2E-only artificial backend latency (repro for latency-dependent UI states,
 * e.g. the session-open empty flash). When E2E_LATENCY_* env vars are set at
 * Metro bundle time, matching procedure responses arrive late at the app —
 * the same condition a slow production backend creates. Disabled (0) unless
 * the env vars are explicitly set; never set them outside E2E.
 */
const E2E_LATENCY_RULES: readonly (readonly [procedure: string, delayMs: number])[] = [
  ['cliSessionsV2.get', E2E_LATENCY_SESSION_MS],
  ['cliSessionsV2.getSessionMessagesPage', E2E_LATENCY_MESSAGES_MS],
];

function requestUrlString(url: RequestInfo | URL): string {
  if (url instanceof URL) {
    return url.href;
  }
  if (url instanceof Request) {
    return url.url;
  }
  return url;
}

function e2eLatencyForUrl(url: string): number {
  let delayMs = 0;
  for (const [procedure, procedureDelayMs] of E2E_LATENCY_RULES) {
    if (procedureDelayMs > delayMs && url.includes(procedure)) {
      delayMs = procedureDelayMs;
    }
  }
  return delayMs;
}

const e2eLatencyFetch: typeof fetch = async (url, init) => {
  const delayMs = e2eLatencyForUrl(requestUrlString(url));
  if (delayMs > 0) {
    await new Promise(resolve => {
      setTimeout(resolve, delayMs);
    });
  }
  return fetch(url, init);
};

const e2eFetch =
  E2E_LATENCY_SESSION_MS > 0 || E2E_LATENCY_MESSAGES_MS > 0 ? e2eLatencyFetch : fetch;

/**
 * Fetch wrapper that adds a control-plane deadline (15 s). When E2E latency
 * values are set the deadline is extended by the applicable delay so the
 * synthetic latency does not eat into the real request budget.
 */
export const deadlineFetch: typeof fetch = async (url, init) => {
  const delayMs = e2eLatencyForUrl(requestUrlString(url));
  const totalDeadline = CONTROL_PLANE_DEADLINE_MS + delayMs;
  const response = await withDeadline(
    totalDeadline,
    async signal => {
      const res = await e2eFetch(url, { ...init, signal });
      return res;
    },
    init?.signal ?? undefined
  );
  return response;
};

// Reports every failed (or >=400) tRPC request once at warning level. The
// global fetch wrapper skips `/api/trpc` URLs so this is the only reporter.
// A batched call answers 207 when it mixes results and errors; the body is
// parsed (via a clone) so the failing procedure's code is reported.
const observedFetch = createNetworkErrorFetch(deadlineFetch, {
  source: 'trpc',
  isResponseError: status => status >= 400 || status === 207,
  readResponseError: readTrpcResponseError,
});

const latencyBuffer = createLatencyBuffer({
  send: postLatencyBatch,
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => {
      clearTimeout(timer);
    };
  },
});

// tRPC's single `httpLink` omits the request body for a call with no input.
// The server reads that as `undefined`, which a procedure with a required
// `.input()` schema rejects with 400 BAD_REQUEST (`activeSessions.list` is
// called that way from the session resolver), while the batched link sends
// `{}` for the same call. Send the empty object the batched link sends so an
// unbatched no-input query reaches its procedure with the input the schema
// expects. Only a POST with no body is touched; a caller's own body is kept.
const withJsonBody: typeof fetch = async (input, init) => {
  const normalized =
    init?.method === 'POST' && init.body === undefined ? { ...init, body: '{}' } : init;
  const response = await observedFetch(input, normalized);
  return response;
};

// Every tRPC HTTP call (single or batched) gets a per-call `x-kilo-request-id`
// header and records one latency sample, so the server timing line and the
// client sample join by the same id. The id comes from the platform `crypto`
// API, which both iOS and Android expose (`randomUUID` on Hermes), so one
// implementation serves both and no native-module import or per-platform
// branch is kept. A runtime without that API still gets an id from the
// timestamp fallback rather than dropping the sample.
function newRequestId(): string {
  // oxlint-disable-next-line anti-slop/no-reflect-get -- a typed access would make TS treat the runtime fallback as dead code
  const platformCrypto = Reflect.get(globalThis, 'crypto') as
    | { randomUUID?: () => string }
    | undefined;
  if (platformCrypto?.randomUUID !== undefined) {
    return platformCrypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const measuredFetch = createLatencyFetch(withJsonBody, latencyBuffer, {
  now: () => Date.now(),
  newId: newRequestId,
});

async function getAuthHeaders() {
  const token = await getAuthTokenForRequest();
  if (!token) {
    return { ...buildAuthHeaders(token), ...buildClientMetadataHeaders() };
  }

  // Proactive refresh: if the token is expiring within the margin, rotate
  // before this request hits a 401. performRefresh handles single-flight
  // so concurrent requests share one rotation. The expiry comes from the
  // in-memory owner when available; only the cold path (owner warmed by
  // getAuthTokenForRequest without an expiry) reads TOKEN_EXPIRES_AT_KEY,
  // and the resolved value is published back into the owner so normal
  // requests never reread it.
  const active = getActiveTokenSnapshot();
  let expiresAtMs = active?.expiresAtMs ?? null;
  if (expiresAtMs === null) {
    const expiresAtStr = await SecureStore.getItemAsync(TOKEN_EXPIRES_AT_KEY);
    const resolvedExpiresAtMs = expiresAtStr ? Number(expiresAtStr) : null;
    // Publish the resolved expiry into the owner that the cold read warmed.
    // A newer owner published while the expiry was read keeps its own token
    // and expiry.
    if (active) {
      publishActiveTokenExpiry(active, resolvedExpiresAtMs);
    }
    expiresAtMs = resolvedExpiresAtMs;
  }
  // Prefer the newest owner token: a sign-in or refresh may have published a
  // newer one while the cold reads were in flight.
  const newest = getActiveToken();
  const currentToken = newest?.token ?? token;
  const currentExpiresAtMs = newest ? newest.expiresAtMs : expiresAtMs;
  if (
    currentExpiresAtMs !== null &&
    shouldRefreshBeforeRequest(currentExpiresAtMs, Date.now(), REFRESH_MARGIN_MS)
  ) {
    await performRefresh();
    const refreshedToken = getActiveToken()?.token ?? (await getAuthTokenForRequest());
    return { ...buildAuthHeaders(refreshedToken), ...buildClientMetadataHeaders() };
  }

  return { ...buildAuthHeaders(currentToken), ...buildClientMetadataHeaders() };
}

const singleLink = httpLink({
  url: trpcUrl,
  headers: getAuthHeaders,
  fetch: measuredFetch,
  methodOverride: 'POST',
});

const batchLink = httpBatchLink({
  url: trpcUrl,
  headers: getAuthHeaders,
  fetch: measuredFetch,
  methodOverride: 'POST',
});

const trpcLinks = [
  splitLink({
    condition: op => op.context.skipBatch === true || UNBATCHED_PROCEDURES.has(op.path),
    true: singleLink,
    false: batchLink,
  }),
];

export const trpcClient = createTRPCClient<MobileRouter>({
  links: trpcLinks,
});
