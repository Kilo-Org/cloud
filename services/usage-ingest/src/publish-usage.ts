import { timingSafeEqual } from '@kilocode/encryption';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import { UsageRecordRequestSchema, type UsageRecordRequest } from '@kilocode/usage-contracts';
import { logSafely, queueMetrics } from './diagnostics';

export type Env = Omit<
  CloudflareEnv,
  | 'USAGE_INGEST_QUEUE'
  | 'USAGE_WRITER_URL'
  | 'USAGE_INGEST_DIAGNOSTICS'
  | 'USAGE_INGEST_PARALLELISM'
> & {
  USAGE_INGEST_QUEUE: Queue<UsageRecordRequest>;
  USAGE_INGEST_PUBLISH_SECRET?: string;
  USAGE_INGEST_PARALLELISM?: string;
  USAGE_WRITER_URL?: string;
  USAGE_WRITER_SECRET?: string;
  USAGE_WRITER_PROTECTION_BYPASS?: string;
  USAGE_INGEST_DIAGNOSTICS?: string;
};

// Queues allow 128,000 bytes including internal metadata; leave 8,000 bytes of headroom.
export const MAX_USAGE_BYTES = 120_000;

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

async function readUsageBody(request: Request) {
  if (!request.body) return { error: errorResponse('Invalid JSON', 400) };

  try {
    const result = await readBoundedStream(
      request.body as ReadableStream<Uint8Array>,
      MAX_USAGE_BYTES
    );
    if (!result.ok) {
      return { error: errorResponse('Usage payload too large', 413) };
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(result.bytes);
    const value: unknown = JSON.parse(text);
    return { value };
  } catch {
    return { error: errorResponse('Invalid JSON', 400) };
  }
}

async function handlePublishUsage(
  request: Request,
  env: Env,
  entryAtMs: number
): Promise<Response> {
  const secret = env.USAGE_INGEST_PUBLISH_SECRET;
  if (!secret) return errorResponse('Service unavailable', 503);
  const authorization = request.headers.get('Authorization');
  if (!authorization || !timingSafeEqual(authorization, `Bearer ${secret}`)) {
    return errorResponse('Unauthorized', 401);
  }

  const body = await readUsageBody(request);
  if (body.error) return body.error;
  const result = UsageRecordRequestSchema.safeParse(body.value);
  if (!result.success) return errorResponse('Invalid usage payload', 400);

  try {
    if (new TextEncoder().encode(JSON.stringify(result.data)).byteLength > MAX_USAGE_BYTES) {
      return errorResponse('Usage payload too large', 413);
    }
  } catch {
    return errorResponse('Usage payload too large', 413);
  }

  const diagnostic = env.USAGE_INGEST_DIAGNOSTICS === 'all';
  const beforeSendAtMs = Date.now();
  if (diagnostic)
    logSafely('info', () => ({
      event: 'usage_ingest_enqueue_start',
      usage_id: result.data.core.id,
      publisher_entry_at_ms: entryAtMs,
      before_send_at_ms: beforeSendAtMs,
    }));
  const sendStartedAt = performance.now();
  let response: unknown;
  try {
    response = await env.USAGE_INGEST_QUEUE.send(result.data, { contentType: 'json' });
  } catch {
    if (diagnostic)
      logSafely('warn', () => ({
        event: 'usage_ingest_enqueue',
        usage_id: result.data.core.id,
        outcome: 'unavailable',
        after_send_at_ms: Date.now(),
        send_duration_ms: Math.round(performance.now() - sendStartedAt),
      }));
    return errorResponse('Queue unavailable', 503);
  }
  const afterSendAtMs = Date.now();
  const sendDurationMs = Math.round(performance.now() - sendStartedAt);
  if (diagnostic)
    logSafely('info', () => ({
      event: 'usage_ingest_enqueue',
      usage_id: result.data.core.id,
      outcome: 'accepted',
      publisher_entry_at_ms: entryAtMs,
      before_send_at_ms: beforeSendAtMs,
      after_send_at_ms: afterSendAtMs,
      send_duration_ms: sendDurationMs,
      ...queueMetrics(response),
    }));
  return new Response(null, { status: 202 });
}

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const entryAtMs = Date.now();
  if (new URL(request.url).pathname !== '/usage') {
    return new Response('Not Found', { status: 404 });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }

  return handlePublishUsage(request, env, entryAtMs);
}
