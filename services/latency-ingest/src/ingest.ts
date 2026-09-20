import { isVersionBelow } from '@kilocode/app-shared/app-version';
import * as z from 'zod';

/** Reject a request whose raw body is larger than this before parsing it. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Reject a batch with more samples than this. */
export const MAX_BATCH_SAMPLES = 50;

const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/** Hex characters of the SHA-256 bearer digest used as the limiter key. */
const SESSION_KEY_HEX_LENGTH = 32;

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
 * The bearer is only the per-session identity; it is hashed before it reaches
 * the limiter and is never logged.
 */
function bearerToken(authorization: string | null): string | null {
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return null;
  }
  const token = authorization.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

async function sessionKey(bearer: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bearer));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(
    ''
  );
  return hex.slice(0, SESSION_KEY_HEX_LENGTH);
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

  const { success } = await deps.rateLimiter.limit({ key: await sessionKey(bearer) });
  if (!success) {
    return errorResponse(429);
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_PAYLOAD_BYTES) {
    return errorResponse(413);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_PAYLOAD_BYTES) {
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
