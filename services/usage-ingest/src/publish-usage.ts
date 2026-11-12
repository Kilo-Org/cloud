import { timingSafeEqual } from '@kilocode/encryption';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import {
  UsageRecordRequestSchema,
  type LlmUsageQueueMessage,
  type UsageQueueMessage,
} from '@kilocode/usage-contracts';
import {
  recordLlmUsage,
  type LlmUsageWriteOutcome,
} from '@kilocode/worker-utils/usage-writer-client';
import { logSafely, queueMetrics } from './diagnostics';
import { handlePublishEnkryptUsage } from './publish-enkrypt-usage';
import { schemaRejectionDetails } from './rejection-diagnostics';

export type Env = Omit<
  CloudflareEnv,
  | 'USAGE_INGEST_QUEUE'
  | 'USAGE_WRITER_URL'
  | 'USAGE_INGEST_PARALLELISM'
  | 'USAGE_INGEST_DIRECT_MODE'
  | 'USAGE_INGEST_DIRECT_TIMEOUT_MS'
  | 'USAGE_INGEST_STALL_HEDGE_MS'
  | 'USAGE_DIRECT_LIMITER'
> & {
  USAGE_INGEST_QUEUE: Queue<UsageQueueMessage>;
  USAGE_INGEST_PUBLISH_SECRET?: string;
  USAGE_INGEST_PARALLELISM?: string;
  USAGE_INGEST_DIRECT_MODE?: string;
  USAGE_INGEST_DIRECT_TIMEOUT_MS?: string;
  USAGE_INGEST_STALL_HEDGE_MS?: string;
  USAGE_DIRECT_LIMITER?: RateLimit;
  USAGE_WRITER_URL?: string;
  USAGE_WRITER_SECRET?: string;
  USAGE_WRITER_PROTECTION_BYPASS?: string;
};

type DirectMode = 'off' | 'on_stall' | 'first';
const DEFAULT_DIRECT_TIMEOUT_MS = 2000;
const DEFAULT_STALL_HEDGE_MS = 2000;
// A constant key makes the limiter one shared cap for direct attempts in each
// Cloudflare location rather than a per-payer allowance.
const DIRECT_LIMITER_KEY = 'ingress_direct';

// Queues allow 128,000 bytes including internal metadata; leave 8,000 bytes of headroom.
export const MAX_USAGE_BYTES = 120_000;

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

async function readUsageBody(request: Request) {
  if (!request.body) {
    logSafely('warn', () => ({ event: 'usage_ingest_rejected', category: 'missing_body' }));
    return { error: errorResponse('Invalid JSON', 400) };
  }

  // Track the current stage so the catch can classify failures without logging error text.
  let category = 'body_read_failure';
  try {
    const result = await readBoundedStream(
      request.body as ReadableStream<Uint8Array>,
      MAX_USAGE_BYTES
    );
    if (!result.ok) {
      return { error: errorResponse('Usage payload too large', 413) };
    }
    category = 'invalid_utf8';
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(result.bytes);
    category = 'malformed_json';
    const value: unknown = JSON.parse(text);
    return { value };
  } catch {
    logSafely('warn', () => ({ event: 'usage_ingest_rejected', category }));
    return { error: errorResponse('Invalid JSON', 400) };
  }
}

function observeEnqueueCompletion(
  pending: Promise<unknown>,
  sendStartedAt: number,
  usageId: string,
  ctx: ExecutionContext | undefined
): void {
  if (!ctx) return;
  const observed = pending.then(
    () => logCompletion(sendStartedAt, usageId, 'accepted'),
    () => logCompletion(sendStartedAt, usageId, 'unavailable')
  );
  try {
    ctx.waitUntil(observed);
  } catch {
    logSafely('warn', () => ({
      event: 'usage_ingest_enqueue_observation_unregistered',
      usage_id: usageId,
    }));
  }
}

function logCompletion(sendStartedAt: number, usageId: string, outcome: string): void {
  logSafely(outcome === 'accepted' ? 'info' : 'warn', () => ({
    event: 'usage_ingest_enqueue_observed',
    usage_id: usageId,
    outcome,
    send_duration_ms: Math.round(performance.now() - sendStartedAt),
  }));
}

function directMode(value: string | undefined): DirectMode {
  return value === 'on_stall' || value === 'first' ? value : 'off';
}

function positiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

type DirectOutcome =
  | LlmUsageWriteOutcome['kind']
  | Extract<LlmUsageWriteOutcome, { kind: 'unavailable' }>['reason']
  | 'rate_limited'
  | 'limiter_unavailable';

type DirectAttempt = {
  accepted: boolean;
  outcome: DirectOutcome;
  rateLimited: boolean;
  durationMs?: number;
  status?: number;
  admissionReason?: string;
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function logLimiterFailure(usageId: string, error: string): void {
  logSafely('warn', () => ({
    event: 'usage_ingest_direct_limiter_failed',
    usage_id: usageId,
    error_name: error,
  }));
}

async function directPermitted(
  limiter: RateLimit | undefined,
  usageId: string,
  timeoutMs: number
): Promise<DirectOutcome | null> {
  if (!limiter) return 'limiter_unavailable';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'expired'>(resolve => {
    timer = setTimeout(() => resolve('expired'), timeoutMs);
  });
  try {
    const result = await Promise.race([limiter.limit({ key: DIRECT_LIMITER_KEY }), expired]);
    if (result === 'expired') {
      logLimiterFailure(usageId, 'TimeoutError');
      return 'limiter_unavailable';
    }
    return result.success ? null : 'rate_limited';
  } catch (error) {
    logLimiterFailure(usageId, errorName(error));
    return 'limiter_unavailable';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One direct write; never retried, and every failure leaves the queue lane to decide.
 * One deadline covers the limiter call and the writer call, so neither can hold the
 * request past `USAGE_INGEST_DIRECT_TIMEOUT_MS`.
 */
async function attemptDirect(usage: LlmUsageQueueMessage, env: Env): Promise<DirectAttempt> {
  const timeoutMs = positiveMs(env.USAGE_INGEST_DIRECT_TIMEOUT_MS, DEFAULT_DIRECT_TIMEOUT_MS);
  const deadline = performance.now() + timeoutMs;
  const refused = await directPermitted(env.USAGE_DIRECT_LIMITER, usage.core.id, timeoutMs);
  if (refused) return { accepted: false, outcome: refused, rateLimited: true };
  const startedAt = performance.now();
  let outcome: LlmUsageWriteOutcome;
  try {
    outcome = await recordLlmUsage(usage, {
      url: env.USAGE_WRITER_URL,
      secret: env.USAGE_WRITER_SECRET,
      protectionBypass: env.USAGE_WRITER_PROTECTION_BYPASS,
      source: 'ingress_direct',
      timeoutMs: Math.max(1, Math.floor(deadline - startedAt)),
    });
  } catch (error) {
    logSafely('warn', () => ({
      event: 'usage_ingest_direct_failed',
      usage_id: usage.core.id,
      error_name: errorName(error),
    }));
    outcome = { kind: 'unavailable', reason: 'request_failed' };
  }
  const durationMs = Math.round(performance.now() - startedAt);
  if (outcome.kind !== 'unavailable') {
    return { accepted: true, outcome: outcome.kind, rateLimited: false, durationMs };
  }
  return {
    accepted: false,
    outcome: outcome.reason,
    rateLimited: false,
    durationMs,
    ...(outcome.status === undefined ? {} : { status: outcome.status }),
    ...(outcome.admissionReason === undefined ? {} : { admissionReason: outcome.admissionReason }),
  };
}

type StartedSend =
  | { started: false; response: Response }
  | { started: true; pending: Promise<unknown>; sendStartedAt: number; beforeSendAtMs: number };

function startSend(
  usage: LlmUsageQueueMessage,
  env: Env,
  entryAtMs: number,
  ctx: ExecutionContext | undefined
): StartedSend {
  const beforeSendAtMs = Date.now();
  logSafely('info', () => ({
    event: 'usage_ingest_enqueue_start',
    usage_id: usage.core.id,
    publisher_entry_at_ms: entryAtMs,
    before_send_at_ms: beforeSendAtMs,
  }));
  const sendStartedAt = performance.now();
  let pending: Promise<unknown>;
  try {
    pending = env.USAGE_INGEST_QUEUE.send(usage satisfies LlmUsageQueueMessage, {
      contentType: 'json',
    });
  } catch (error) {
    logSafely('warn', () => ({
      event: 'usage_ingest_enqueue',
      usage_id: usage.core.id,
      outcome: 'unavailable',
      after_send_at_ms: Date.now(),
      send_duration_ms: Math.round(performance.now() - sendStartedAt),
      error_name: errorName(error),
    }));
    return { started: false, response: errorResponse('Queue unavailable', 503) };
  }
  observeEnqueueCompletion(pending, sendStartedAt, usage.core.id, ctx);
  return { started: true, pending, sendStartedAt, beforeSendAtMs };
}

async function finishSend(
  send: Extract<StartedSend, { started: true }>,
  usage: LlmUsageQueueMessage,
  entryAtMs: number
): Promise<Response> {
  let response: unknown;
  try {
    response = await send.pending;
  } catch (error) {
    logSafely('warn', () => ({
      event: 'usage_ingest_enqueue',
      usage_id: usage.core.id,
      outcome: 'unavailable',
      after_send_at_ms: Date.now(),
      send_duration_ms: Math.round(performance.now() - send.sendStartedAt),
      error_name: errorName(error),
    }));
    return errorResponse('Queue unavailable', 503);
  }
  const afterSendAtMs = Date.now();
  const sendDurationMs = Math.round(performance.now() - send.sendStartedAt);
  logSafely('info', () => ({
    event: 'usage_ingest_enqueue',
    usage_id: usage.core.id,
    outcome: 'accepted',
    publisher_entry_at_ms: entryAtMs,
    before_send_at_ms: send.beforeSendAtMs,
    after_send_at_ms: afterSendAtMs,
    send_duration_ms: sendDurationMs,
    ...queueMetrics(response),
  }));
  return new Response(null, { status: 202 });
}

async function enqueue(
  usage: LlmUsageQueueMessage,
  env: Env,
  entryAtMs: number,
  ctx: ExecutionContext | undefined
): Promise<Response> {
  const send = startSend(usage, env, entryAtMs, ctx);
  return send.started ? finishSend(send, usage, entryAtMs) : send.response;
}

function directFields(direct: DirectAttempt): object {
  return {
    direct_outcome: direct.outcome,
    ...(direct.durationMs === undefined ? {} : { direct_duration_ms: direct.durationMs }),
    ...(direct.status === undefined ? {} : { direct_status: direct.status }),
    ...(direct.admissionReason === undefined
      ? {}
      : { direct_admission_reason: direct.admissionReason }),
  };
}

function logPublish(
  mode: Exclude<DirectMode, 'off'>,
  usageId: string,
  status: number,
  direct: DirectAttempt | 'pending' | undefined,
  sendDurationMs: number | undefined
): void {
  logSafely(status === 202 ? 'info' : 'warn', () => ({
    event: 'usage_ingest_publish',
    mode,
    lane: typeof direct === 'object' && direct.accepted ? 'direct' : 'queue',
    status,
    usage_id: usageId,
    rate_limited: typeof direct === 'object' && direct.rateLimited,
    ...(direct === 'pending' ? { direct_pending: true } : direct ? directFields(direct) : {}),
    ...(sendDurationMs === undefined ? {} : { send_duration_ms: sendDurationMs }),
  }));
}

/** Work after the response; it never rejects, and without a context it is not kept alive. */
function extendLifetime(
  work: Promise<unknown>,
  ctx: ExecutionContext | undefined,
  usageId: string
): void {
  const handled = work.then(
    () => undefined,
    (error: unknown) =>
      logSafely('warn', () => ({
        event: 'usage_ingest_background_failed',
        usage_id: usageId,
        error_name: errorName(error),
      }))
  );
  if (!ctx) return;
  try {
    ctx.waitUntil(handled);
  } catch (error) {
    logSafely('warn', () => ({
      event: 'usage_ingest_background_unregistered',
      usage_id: usageId,
      error_name: errorName(error),
    }));
  }
}

function observeParkedDirect(
  directPending: Promise<DirectAttempt>,
  usageId: string,
  ctx: ExecutionContext | undefined
): void {
  extendLifetime(
    directPending.then(direct =>
      logSafely(direct.accepted ? 'info' : 'warn', () => ({
        event: 'usage_ingest_direct_observed',
        usage_id: usageId,
        rate_limited: direct.rateLimited,
        ...directFields(direct),
      }))
    ),
    ctx,
    usageId
  );
}

function elapsedSince(send: StartedSend): number | undefined {
  return send.started ? Math.round(performance.now() - send.sendStartedAt) : undefined;
}

async function publishDirectFirst(
  usage: LlmUsageQueueMessage,
  env: Env,
  entryAtMs: number,
  ctx: ExecutionContext | undefined
): Promise<Response> {
  const direct = await attemptDirect(usage, env);
  if (direct.accepted) {
    logPublish('first', usage.core.id, 202, direct, undefined);
    return new Response(null, { status: 202 });
  }
  const send = startSend(usage, env, entryAtMs, ctx);
  const response = send.started ? await finishSend(send, usage, entryAtMs) : send.response;
  logPublish('first', usage.core.id, response.status, direct, elapsedSince(send));
  return response;
}

async function publishHedgedOnStall(
  usage: LlmUsageQueueMessage,
  env: Env,
  entryAtMs: number,
  ctx: ExecutionContext | undefined
): Promise<Response> {
  const usageId = usage.core.id;
  const send = startSend(usage, env, entryAtMs, ctx);
  if (!send.started) {
    logPublish('on_stall', usageId, send.response.status, undefined, undefined);
    return send.response;
  }
  // `finishSend` awaits the same promise and logs a rejection with its error name.
  const sendResult = Promise.allSettled([send.pending]).then(([settled]) =>
    settled.status === 'fulfilled' ? ('accepted' as const) : ('unavailable' as const)
  );
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  const hedgeDue = new Promise<'hedge'>(resolve => {
    hedgeTimer = setTimeout(
      () => resolve('hedge'),
      positiveMs(env.USAGE_INGEST_STALL_HEDGE_MS, DEFAULT_STALL_HEDGE_MS)
    );
  });
  const beforeHedge = await Promise.race([sendResult, hedgeDue]);
  clearTimeout(hedgeTimer);
  if (beforeHedge !== 'hedge') {
    const response = await finishSend(send, usage, entryAtMs);
    logPublish('on_stall', usageId, response.status, undefined, elapsedSince(send));
    return response;
  }

  // The send may already be enqueued; the writer's usage-id idempotency makes the
  // later queue delivery a `duplicate` rather than a second debit.
  const directPending = attemptDirect(usage, env).catch((error: unknown): DirectAttempt => {
    logSafely('warn', () => ({
      event: 'usage_ingest_direct_failed',
      usage_id: usageId,
      error_name: errorName(error),
    }));
    return { accepted: false, outcome: 'request_failed', rateLimited: false };
  });
  const firstSettled = await Promise.race([
    directPending.then(direct => ({ lane: 'direct' as const, direct })),
    sendResult.then(queue => ({ lane: 'queue' as const, queue })),
  ]);
  if (firstSettled.lane === 'queue' && firstSettled.queue === 'accepted') {
    const response = await finishSend(send, usage, entryAtMs);
    logPublish('on_stall', usageId, response.status, 'pending', elapsedSince(send));
    observeParkedDirect(directPending, usageId, ctx);
    return response;
  }
  // A failed send does not decide the response while the direct write can still succeed.
  const direct = firstSettled.lane === 'direct' ? firstSettled.direct : await directPending;
  if (direct.accepted) {
    extendLifetime(finishSend(send, usage, entryAtMs), ctx, usageId);
    logPublish('on_stall', usageId, 202, direct, undefined);
    return new Response(null, { status: 202 });
  }
  const response = await finishSend(send, usage, entryAtMs);
  logPublish('on_stall', usageId, response.status, direct, elapsedSince(send));
  return response;
}

async function handlePublishUsage(
  request: Request,
  env: Env,
  entryAtMs: number,
  ctx?: ExecutionContext
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
  if (!result.success) {
    logSafely('warn', () => ({
      event: 'usage_ingest_rejected',
      category: 'schema_failure',
      ...schemaRejectionDetails(result.error, body.value),
    }));
    return errorResponse('Invalid usage payload', 400);
  }

  try {
    if (new TextEncoder().encode(JSON.stringify(result.data)).byteLength > MAX_USAGE_BYTES) {
      return errorResponse('Usage payload too large', 413);
    }
  } catch (error) {
    logSafely('warn', () => ({
      event: 'usage_ingest_serialization_failed',
      usage_id: result.data.core.id,
      error_name: errorName(error),
    }));
    return errorResponse('Usage payload too large', 413);
  }

  const mode = directMode(env.USAGE_INGEST_DIRECT_MODE);
  if (mode === 'first') return publishDirectFirst(result.data, env, entryAtMs, ctx);
  if (mode === 'on_stall') return publishHedgedOnStall(result.data, env, entryAtMs, ctx);
  return enqueue(result.data, env, entryAtMs, ctx);
}

export async function handleFetch(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  const entryAtMs = Date.now();
  const pathname = new URL(request.url).pathname;
  if (pathname !== '/usage' && pathname !== '/enkrypt-usage') {
    return new Response('Not Found', { status: 404 });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  if (pathname === '/enkrypt-usage') return handlePublishEnkryptUsage(request, env, entryAtMs);

  return handlePublishUsage(request, env, entryAtMs, ctx);
}
