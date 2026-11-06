import { timingSafeEqual } from '@kilocode/encryption';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import { UsageRecordRequestSchema, type UsageRecordRequest } from '@kilocode/usage-contracts';
import { recordUsage, type UsageWriteOutcome } from '@kilocode/worker-utils/usage-writer-client';
import { logSafely, queueMetrics } from './diagnostics';
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
  USAGE_INGEST_QUEUE: Queue<UsageRecordRequest>;
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
  | UsageWriteOutcome['kind']
  | Extract<UsageWriteOutcome, { kind: 'unavailable' }>['reason']
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

async function directPermitted(limiter: RateLimit | undefined): Promise<DirectOutcome | null> {
  if (!limiter) return 'limiter_unavailable';
  try {
    const { success } = await limiter.limit({ key: DIRECT_LIMITER_KEY });
    return success ? null : 'rate_limited';
  } catch {
    return 'limiter_unavailable';
  }
}

/** One direct write; never retried, and every failure leaves the queue lane to decide. */
async function attemptDirect(usage: UsageRecordRequest, env: Env): Promise<DirectAttempt> {
  const refused = await directPermitted(env.USAGE_DIRECT_LIMITER);
  if (refused) return { accepted: false, outcome: refused, rateLimited: true };
  const startedAt = performance.now();
  let outcome: UsageWriteOutcome;
  try {
    outcome = await recordUsage(usage, {
      url: env.USAGE_WRITER_URL,
      secret: env.USAGE_WRITER_SECRET,
      protectionBypass: env.USAGE_WRITER_PROTECTION_BYPASS,
      source: 'ingress_direct',
      timeoutMs: positiveMs(env.USAGE_INGEST_DIRECT_TIMEOUT_MS, DEFAULT_DIRECT_TIMEOUT_MS),
    });
  } catch {
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
  usage: UsageRecordRequest,
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
    pending = env.USAGE_INGEST_QUEUE.send(usage, { contentType: 'json' });
  } catch {
    logSafely('warn', () => ({
      event: 'usage_ingest_enqueue',
      usage_id: usage.core.id,
      outcome: 'unavailable',
      after_send_at_ms: Date.now(),
      send_duration_ms: Math.round(performance.now() - sendStartedAt),
    }));
    return { started: false, response: errorResponse('Queue unavailable', 503) };
  }
  observeEnqueueCompletion(pending, sendStartedAt, usage.core.id, ctx);
  return { started: true, pending, sendStartedAt, beforeSendAtMs };
}

async function finishSend(
  send: Extract<StartedSend, { started: true }>,
  usage: UsageRecordRequest,
  entryAtMs: number
): Promise<Response> {
  let response: unknown;
  try {
    response = await send.pending;
  } catch {
    logSafely('warn', () => ({
      event: 'usage_ingest_enqueue',
      usage_id: usage.core.id,
      outcome: 'unavailable',
      after_send_at_ms: Date.now(),
      send_duration_ms: Math.round(performance.now() - send.sendStartedAt),
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
  usage: UsageRecordRequest,
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
    () => undefined
  );
  if (!ctx) return;
  try {
    ctx.waitUntil(handled);
  } catch {
    logSafely('warn', () => ({ event: 'usage_ingest_background_unregistered', usage_id: usageId }));
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
  usage: UsageRecordRequest,
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
  usage: UsageRecordRequest,
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
  const sendResult = send.pending.then(
    () => 'accepted' as const,
    () => 'unavailable' as const
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
  const directPending = attemptDirect(usage, env).catch((): DirectAttempt => ({
    accepted: false,
    outcome: 'request_failed',
    rateLimited: false,
  }));
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
  } catch {
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
  if (new URL(request.url).pathname !== '/usage') {
    return new Response('Not Found', { status: 404 });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }

  return handlePublishUsage(request, env, entryAtMs, ctx);
}
