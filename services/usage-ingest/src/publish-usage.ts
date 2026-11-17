import { timingSafeEqual } from '@kilocode/encryption';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import {
  UsageRecordRequestSchema,
  type LlmUsageQueueMessage,
  type UsageQueueMessage,
} from '@kilocode/usage-contracts';
import { logSafely, queueMetrics } from './diagnostics';
import { handlePublishEnkryptUsage } from './publish-enkrypt-usage';
import { handlePublishExaUsage } from './publish-exa-usage';
import { schemaRejectionDetails } from './rejection-diagnostics';

export type Env = Omit<
  CloudflareEnv,
  | 'USAGE_INGEST_QUEUE'
  | 'USAGE_INGEST_HEDGE_QUEUE'
  | 'USAGE_WRITER_URL'
  | 'USAGE_INGEST_PARALLELISM'
  | 'USAGE_INGEST_HEDGE_MODE'
  | 'USAGE_INGEST_HEDGE_DELAY_MS'
  | 'USAGE_INGEST_HEDGE_PERCENT'
> & {
  USAGE_INGEST_QUEUE: Queue<UsageQueueMessage>;
  USAGE_INGEST_HEDGE_QUEUE?: Queue<UsageQueueMessage>;
  USAGE_INGEST_PUBLISH_SECRET?: string;
  USAGE_INGEST_PARALLELISM?: string;
  USAGE_INGEST_HEDGE_MODE?: string;
  USAGE_INGEST_HEDGE_DELAY_MS?: string;
  USAGE_INGEST_HEDGE_PERCENT?: string;
  USAGE_WRITER_URL?: string;
  USAGE_WRITER_SECRET?: string;
  USAGE_WRITER_PROTECTION_BYPASS?: string;
};

// Queues allow 128,000 bytes including internal metadata; leave 8,000 bytes of headroom.
export const MAX_USAGE_BYTES = 120_000;

export const DEFAULT_HEDGE_DELAY_MS = 1000;
export const MIN_HEDGE_DELAY_MS = 250;
export const MAX_HEDGE_DELAY_MS = 10_000;
const DEFAULT_HEDGE_PERCENT = 100;

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

  const usage = result.data;
  if (
    hedgeMode(env.USAGE_INGEST_HEDGE_MODE) === 'on' &&
    hedgeEligible(usage.core.id, hedgePercent(env.USAGE_INGEST_HEDGE_PERCENT))
  ) {
    return publishWithHedge(usage, env, entryAtMs, ctx);
  }
  const send = startSend(usage, env, entryAtMs, ctx);
  return send instanceof Response ? send : finishSend(send, usage.core.id, entryAtMs);
}

type StartedSend = { pending: Promise<unknown>; sendStartedAt: number; beforeSendAtMs: number };

function logEnqueueUnavailable(usageId: string, sendStartedAt: number): void {
  logSafely('warn', () => ({
    event: 'usage_ingest_enqueue',
    usage_id: usageId,
    outcome: 'unavailable',
    after_send_at_ms: Date.now(),
    send_duration_ms: Math.round(performance.now() - sendStartedAt),
  }));
}

function startSend(
  usage: LlmUsageQueueMessage,
  env: Env,
  entryAtMs: number,
  ctx: ExecutionContext | undefined
): StartedSend | Response {
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
  } catch {
    logEnqueueUnavailable(usage.core.id, sendStartedAt);
    return errorResponse('Queue unavailable', 503);
  }
  observeEnqueueCompletion(pending, sendStartedAt, usage.core.id, ctx);
  return { pending, sendStartedAt, beforeSendAtMs };
}

/** Logs the main send's `usage_ingest_enqueue` result; it never rejects. */
async function finishSend(
  send: StartedSend,
  usageId: string,
  entryAtMs: number
): Promise<Response> {
  let response: unknown;
  try {
    response = await send.pending;
  } catch {
    logEnqueueUnavailable(usageId, send.sendStartedAt);
    return errorResponse('Queue unavailable', 503);
  }
  const afterSendAtMs = Date.now();
  const sendDurationMs = Math.round(performance.now() - send.sendStartedAt);
  logSafely('info', () => ({
    event: 'usage_ingest_enqueue',
    usage_id: usageId,
    outcome: 'accepted',
    publisher_entry_at_ms: entryAtMs,
    before_send_at_ms: send.beforeSendAtMs,
    after_send_at_ms: afterSendAtMs,
    send_duration_ms: sendDurationMs,
    ...queueMetrics(response),
  }));
  return new Response(null, { status: 202 });
}

export function hedgeMode(value: string | undefined): 'on' | 'off' {
  return value === 'on' ? 'on' : 'off';
}

export function hedgeDelayMs(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) return DEFAULT_HEDGE_DELAY_MS;
  return Math.min(MAX_HEDGE_DELAY_MS, Math.max(MIN_HEDGE_DELAY_MS, Number(value)));
}

export function hedgePercent(value: string | undefined): number {
  if (value === undefined || !/^\d{1,3}$/.test(value)) return DEFAULT_HEDGE_PERCENT;
  const percent = Number(value);
  return percent <= 100 ? percent : DEFAULT_HEDGE_PERCENT;
}

/**
 * Selects by the usage ID's last hex digit so hedged (treatment) and unhedged (control) events
 * inside the same stall can be told apart in gateway logs from the usage ID alone.
 */
export function hedgeEligible(usageId: string, percent: number): boolean {
  const lastCharacter = usageId.at(-1);
  if (lastCharacter === undefined || !/^[0-9a-f]$/i.test(lastCharacter)) return false;
  return Number.parseInt(lastCharacter, 16) < Math.round((percent * 16) / 100);
}

type SendOutcome = 'accepted' | 'unavailable' | 'not_configured' | 'unregistered';
type SendResult = { outcome: SendOutcome; durationMs?: number; errorName?: string };
type Winner = 'main' | 'hedge' | 'none';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function unavailable(startedAt: number, error: unknown): SendResult {
  return {
    outcome: 'unavailable',
    durationMs: Math.round(performance.now() - startedAt),
    errorName: errorName(error),
  };
}

function settleSend(pending: Promise<unknown>, startedAt: number): Promise<SendResult> {
  return pending.then(
    () => ({ outcome: 'accepted', durationMs: Math.round(performance.now() - startedAt) }),
    (error: unknown) => unavailable(startedAt, error)
  );
}

function keepAlive(
  work: Promise<unknown>,
  ctx: ExecutionContext | undefined,
  usageId: string,
  stage: 'hedge_send' | 'hedge_summary'
): boolean {
  if (!ctx) return false;
  try {
    ctx.waitUntil(work);
    return true;
  } catch (error) {
    logSafely('warn', () => ({
      event: 'usage_ingest_hedge_unregistered',
      usage_id: usageId,
      stage,
      error_name: errorName(error),
    }));
    return false;
  }
}

/**
 * The hedge send is never retried and never rejects. Without a registered request lifetime it
 * is not sent, so the request keeps waiting on the main send exactly as without a hedge.
 */
function startHedgeSend(
  usage: LlmUsageQueueMessage,
  env: Env,
  ctx: ExecutionContext | undefined
): Promise<SendResult> {
  const queue = env.USAGE_INGEST_HEDGE_QUEUE;
  if (!queue) return Promise.resolve({ outcome: 'not_configured' });
  const lifetime = Promise.withResolvers<void>();
  if (!keepAlive(lifetime.promise, ctx, usage.core.id, 'hedge_send')) {
    return Promise.resolve({ outcome: 'unregistered' });
  }
  const startedAt = performance.now();
  let result: Promise<SendResult>;
  try {
    result = settleSend(
      queue.send(usage satisfies LlmUsageQueueMessage, { contentType: 'json' }),
      startedAt
    );
  } catch (error) {
    result = Promise.resolve(unavailable(startedAt, error));
  }
  return result.then(settled => {
    lifetime.resolve();
    return settled;
  });
}

/** A failure on one side never decides the response while the other side can still accept. */
async function firstAcceptance(
  main: Promise<SendResult>,
  hedge: Promise<SendResult>
): Promise<Winner> {
  const first = await Promise.race([
    main.then(result => ({ side: 'main' as const, result })),
    hedge.then(result => ({ side: 'hedge' as const, result })),
  ]);
  if (first.result.outcome === 'accepted') return first.side;
  const otherSide = first.side === 'main' ? 'hedge' : 'main';
  const other = await (otherSide === 'main' ? main : hedge);
  return other.outcome === 'accepted' ? otherSide : 'none';
}

function logHedge(
  usageId: string,
  delayMs: number,
  winner: Winner,
  main: SendResult,
  hedge: SendResult
): void {
  logSafely(winner === 'none' ? 'warn' : 'info', () => ({
    event: 'usage_ingest_hedge',
    usage_id: usageId,
    hedge_delay_ms: delayMs,
    winner,
    main_outcome: main.outcome,
    ...(main.durationMs === undefined ? {} : { main_send_duration_ms: main.durationMs }),
    ...(main.errorName === undefined ? {} : { main_error_name: main.errorName }),
    hedge_outcome: hedge.outcome,
    ...(hedge.durationMs === undefined ? {} : { hedge_send_duration_ms: hedge.durationMs }),
    ...(hedge.errorName === undefined ? {} : { hedge_error_name: hedge.errorName }),
  }));
}

async function publishWithHedge(
  usage: LlmUsageQueueMessage,
  env: Env,
  entryAtMs: number,
  ctx: ExecutionContext | undefined
): Promise<Response> {
  const usageId = usage.core.id;
  const send = startSend(usage, env, entryAtMs, ctx);
  if (send instanceof Response) return send;
  const delayMs = hedgeDelayMs(env.USAGE_INGEST_HEDGE_DELAY_MS);
  const main = settleSend(send.pending, send.sendStartedAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hedgeDue = new Promise<'hedge_due'>(resolve => {
    timer = setTimeout(() => resolve('hedge_due'), delayMs);
  });
  const beforeHedge = await Promise.race([main, hedgeDue]);
  clearTimeout(timer);
  if (beforeHedge !== 'hedge_due') return finishSend(send, usageId, entryAtMs);

  const hedge = startHedgeSend(usage, env, ctx);
  const winner = await firstAcceptance(main, hedge);
  let response: Response;
  let mainLogged: Promise<unknown>;
  if (winner === 'hedge') {
    response = new Response(null, { status: 202 });
    mainLogged = finishSend(send, usageId, entryAtMs);
  } else {
    response = await finishSend(send, usageId, entryAtMs);
    mainLogged = Promise.resolve();
  }
  const summary = Promise.all([main, hedge, mainLogged]).then(([mainResult, hedgeResult]) =>
    logHedge(usageId, delayMs, winner, mainResult, hedgeResult)
  );
  keepAlive(summary, ctx, usageId, 'hedge_summary');
  return response;
}

export async function handleFetch(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  const entryAtMs = Date.now();
  const pathname = new URL(request.url).pathname;
  if (pathname !== '/usage' && pathname !== '/enkrypt-usage' && pathname !== '/exa-usage') {
    return new Response('Not Found', { status: 404 });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  if (pathname === '/enkrypt-usage') return handlePublishEnkryptUsage(request, env, entryAtMs);
  if (pathname === '/exa-usage') return handlePublishExaUsage(request, env, entryAtMs);

  return handlePublishUsage(request, env, entryAtMs, ctx);
}
