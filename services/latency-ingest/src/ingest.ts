import { isVersionBelow } from '@kilocode/app-shared/app-version';
import * as z from 'zod';

/** Reject a request whose raw body is larger than this before parsing it. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Reject a batch with more samples than this. */
export const MAX_BATCH_SAMPLES = 50;

const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/** Prefix of the limiter key, so the edge-client bucket is never confusable. */
const CLIENT_KEY_PREFIX = 'client:';

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
 * isolate's memory. The chunk normalization mirrors the sibling bounded reader
 * at services/cloud-agent-next/src/server.ts, because
 * worker-configuration.d.ts types the stream's chunks as `any`.
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
}

export async function handleLatencyIngest(
  request: Request,
  deps: LatencyIngestDeps
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/v1/latency') {
    return errorResponse(404);
  }

  const bearer = bearerToken(request.headers.get('authorization'));
  if (!bearer) {
    return errorResponse(401);
  }

  const version = request.headers.get('x-kilo-app-version');
  if (!version || !VERSION_PATTERN.test(version) || isVersionBelow(version, deps.minAppVersion)) {
    return errorResponse(403);
  }

  const { success } = await deps.rateLimiter.limit({ key: clientKey(request) });
  if (!success) {
    return errorResponse(429);
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_PAYLOAD_BYTES) {
    return errorResponse(413);
  }

  const rawBody = await readBodyWithinCap(request);
  if (rawBody === null) {
    return errorResponse(413);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse(400);
  }

  const parsed = LatencyBatchSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400);
  }

  const samples = parsed.data.samples;
  if (samples.length > MAX_BATCH_SAMPLES) {
    return errorResponse(413);
  }

  const platform = request.headers.get('x-kilo-app-platform') ?? 'unknown';
  const batchSize = samples.length;

  for (const sample of samples) {
    deps.log({
      type: 'client_latency',
      client: 'mobile',
      platform,
      version,
      requestId: sample.requestId,
      procedures: sample.procedures,
      batchSize,
      ttfbMs: sample.ttfbMs,
      totalMs: sample.totalMs,
      status: sample.status,
      ok: sample.ok,
    });
  }

  return new Response(null, { status: 204 });
}
