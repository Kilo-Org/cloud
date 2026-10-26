import { isVersionBelow } from '@kilocode/app-shared/app-version';
import * as z from 'zod';

/** Reject a request whose raw body is larger than this before parsing it. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Reject a batch with more samples than this. */
export const MAX_BATCH_SAMPLES = 50;

/**
 * Reject a version header longer than this. Store builds report versions such
 * as `1.0.13`, so the cap only bounds the shape of the caller-supplied value
 * and cannot reject a real build.
 */
export const MAX_VERSION_LENGTH = 32;

const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/** Recorded when the platform header is absent or not a known platform. */
const UNKNOWN_PLATFORM = 'unknown';

/** Prefix of the limiter key, so the edge-client bucket is never confusable. */
const CLIENT_KEY_PREFIX = 'client:';

/** The only route this handler serves. */
const INGEST_ROUTE = '/v1/latency';

/**
 * Route value for a request that did not match `INGEST_ROUTE`. The duration
 * line logs this fixed value rather than the requested pathname, because an
 * unauthenticated caller controls the pathname and would otherwise place
 * arbitrary text in the line.
 */
const UNMATCHED_ROUTE = 'unmatched';

const LatencySampleSchema = z
  .object({
    requestId: z.string(),
    procedures: z.array(z.string()),
    ttfbMs: z.number(),
    totalMs: z.number(),
    status: z.number(),
    ok: z.boolean(),
  })
  .strict();

const LatencyBatchSchema = z.object({ samples: z.array(LatencySampleSchema) }).strict();

export type LatencyRateLimiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type LatencyIngestDeps = {
  rateLimiter: LatencyRateLimiter;
  minAppVersion: string;
  log(line: Record<string, unknown>): void;
};

/**
 * The caller dimensions this handler logs once per request. Both come from
 * request headers, so each is bounded before it reaches a log line: `platform`
 * is a fixed value and `version` passed the pattern, the length cap, and the
 * minimum-version check.
 */
type ClientDimensions = {
  platform: 'ios' | 'android' | 'unknown';
  version: string;
};

/** Result of the routed handler: the response plus the dimensions to log. */
type RouteResult = {
  response: Response;
  /** Null until the request has passed the version check. */
  dimensions: ClientDimensions | null;
};

type LatencyIngestOutcome =
  | 'ok'
  | 'not_found'
  | 'unauthorized'
  | 'version_rejected'
  | 'rate_limited'
  | 'payload_too_large'
  | 'invalid_body'
  | 'internal_error';

const OUTCOME_BY_STATUS: Record<number, LatencyIngestOutcome> = {
  204: 'ok',
  400: 'invalid_body',
  401: 'unauthorized',
  403: 'version_rejected',
  404: 'not_found',
  413: 'payload_too_large',
  429: 'rate_limited',
};

/**
 * Emit exactly one duration line per request, so a production 504 on
 * `/v1/latency` is attributable. This handler performs no upstream I/O, so its
 * 504 can only come from the Cloudflare runtime; the line is the server-side
 * timing that the next production pull compares against the gateway budget.
 * `route` is one of two fixed values — the served route, or `unmatched` — never
 * the requested pathname or query string. `platform` and `version` are the
 * request's client dimensions, logged here once per request: `platform` is a
 * fixed value and `version` has already passed the version check. Both stay
 * null until that check passes.
 */
function logIngestDuration(
  deps: LatencyIngestDeps,
  url: URL,
  request: Request,
  status: number,
  startedAt: number,
  dimensions: ClientDimensions | null
): void {
  deps.log({
    route: url.pathname === INGEST_ROUTE ? INGEST_ROUTE : UNMATCHED_ROUTE,
    method: request.method,
    status,
    durationMs: Date.now() - startedAt,
    outcome: OUTCOME_BY_STATUS[status] ?? 'internal_error',
    platform: dimensions?.platform ?? null,
    version: dimensions?.version ?? null,
  });
}

function errorResponse(status: number): Response {
  return new Response(null, { status });
}

/**
 * The bearer is only the per-session identity: presence-checked as the caller's
 * session signal and never logged. It is deliberately NOT the rate-limit key,
 * because it is not verified here and a caller could rotate it to get a fresh
 * bucket on every request.
 */
function bearerToken(authorization: string | null): string | null {
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return null;
  }
  const token = authorization.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * The trusted dimension for the rate limiter. Cloudflare sets
 * `cf-connecting-ip` at the edge and overwrites any caller-supplied value, so
 * a caller cannot mint a new limiter bucket by rotating a header the way it
 * can rotate the unverified bearer. The header is absent only on a local
 * request, where every caller shares the one fallback bucket.
 */
function clientKey(request: Request): string {
  return `${CLIENT_KEY_PREFIX}${request.headers.get('cf-connecting-ip') ?? 'unknown'}`;
}

/**
 * Read the request body, stopping as soon as it exceeds `MAX_PAYLOAD_BYTES`.
 * Returns null when the body is over the cap, so an oversized (or
 * chunked-encoded, content-length-less) payload is never buffered whole in the
 * isolate's memory. A read or cancel that rejects — a client aborting the
 * upload mid-stream — also returns null instead of escaping `handleLatencyIngest`
 * as an unhandled 500, the guard the sibling bounded reader keeps. The chunk
 * normalization mirrors that sibling at services/cloud-agent-next/src/server.ts,
 * because worker-configuration.d.ts types the stream's chunks as `any`.
 */
async function readBodyWithinCap(request: Request): Promise<string | null> {
  const body = request.body;
  if (body === null) {
    return '';
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return text + decoder.decode();
      }
      const bytes = new Uint8Array(chunk.value);
      total += bytes.byteLength;
      if (total > MAX_PAYLOAD_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(bytes, { stream: true });
    }
  } catch {
    return null;
  }
}

export async function handleLatencyIngest(
  request: Request,
  deps: LatencyIngestDeps
): Promise<Response> {
  const url = new URL(request.url);
  const startedAt = Date.now();
  try {
    const { response, dimensions } = await routeLatencyIngest(request, url, deps);
    logIngestDuration(deps, url, request, response.status, startedAt, dimensions);
    return response;
  } catch (err) {
    // A rejected dependency (e.g. the rate-limiter binding) escapes as a
    // Worker 500; still emit the one line so the request stays attributable.
    logIngestDuration(deps, url, request, 500, startedAt, null);
    throw err;
  }
}

async function routeLatencyIngest(
  request: Request,
  url: URL,
  deps: LatencyIngestDeps
): Promise<RouteResult> {
  if (request.method !== 'POST' || url.pathname !== INGEST_ROUTE) {
    return { response: errorResponse(404), dimensions: null };
  }

  const bearer = bearerToken(request.headers.get('authorization'));
  if (!bearer) {
    return { response: errorResponse(401), dimensions: null };
  }

  const version = request.headers.get('x-kilo-app-version');
  if (
    !version ||
    version.length > MAX_VERSION_LENGTH ||
    !VERSION_PATTERN.test(version) ||
    isVersionBelow(version, deps.minAppVersion)
  ) {
    return { response: errorResponse(403), dimensions: null };
  }

  const platformHeader = request.headers.get('x-kilo-app-platform');
  const dimensions: ClientDimensions = {
    platform:
      platformHeader === 'ios' || platformHeader === 'android' ? platformHeader : UNKNOWN_PLATFORM,
    version,
  };

  const { success } = await deps.rateLimiter.limit({ key: clientKey(request) });
  if (!success) {
    return { response: errorResponse(429), dimensions };
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_PAYLOAD_BYTES) {
    return { response: errorResponse(413), dimensions };
  }

  const rawBody = await readBodyWithinCap(request);
  if (rawBody === null) {
    return { response: errorResponse(413), dimensions };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { response: errorResponse(400), dimensions };
  }

  const parsed = LatencyBatchSchema.safeParse(body);
  if (!parsed.success) {
    return { response: errorResponse(400), dimensions };
  }

  const samples = parsed.data.samples;
  if (samples.length > MAX_BATCH_SAMPLES) {
    return { response: errorResponse(413), dimensions };
  }

  const batchSize = samples.length;

  for (const sample of samples) {
    deps.log({
      type: 'client_latency',
      client: 'mobile',
      requestId: sample.requestId,
      procedures: sample.procedures,
      batchSize,
      ttfbMs: sample.ttfbMs,
      totalMs: sample.totalMs,
      status: sample.status,
      ok: sample.ok,
    });
  }

  return { response: new Response(null, { status: 204 }), dimensions };
}
