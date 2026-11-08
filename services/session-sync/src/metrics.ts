import { Buffer } from 'node:buffer';

import type { Env } from './env';
import { failureCause, type FailureCause } from './overload';
import type { SyncError } from './protocol';

export type Metrics = {
  tenant: string;
  doMs: number;
  r2Ms: number;
  sqlMs: number;
  requestBytes: number;
};
const requests = new WeakMap<Request, Metrics>();

export function metricsEnabled(env: Pick<Env, 'SESSION_SYNC_METRICS'>): boolean {
  try {
    return Boolean(env.SESSION_SYNC_METRICS);
  } catch {
    return false;
  }
}

/** Known byte lengths avoid counting streams for in-memory JSON responses. */
export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const text = JSON.stringify(body);
  return textResponse(text, init);
}

export function textResponse(text: string, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  headers.set('content-length', String(Buffer.byteLength(text)));
  return new Response(text, { ...init, headers });
}

function declaredBytes(headers: Headers): number | undefined {
  const value = headers.get('content-length');
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

export function requestMetrics(request: Request): Metrics | undefined {
  return requests.get(request);
}

export async function timed<T>(
  request: Request,
  field: 'doMs' | 'r2Ms' | 'sqlMs',
  fn: () => Promise<T>
): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    const metrics = requests.get(request);
    if (metrics) metrics[field] += performance.now() - started;
  }
}

export function requestRoute(request: Request): string {
  const path = new URL(request.url).pathname;
  if (path === '/v1/auth/exchange') return `${request.method} /v1/auth/exchange`;
  if (path === '/v1/sessions') return `${request.method} /v1/sessions`;
  if (path === '/v1/presence' || path === '/v1/presence/ticket') {
    return `${request.method} ${path}`;
  }
  if (/^\/v1\/presence\/instances\/[^/]+\/commands$/.test(path)) {
    return `${request.method} /v1/presence/instances/:instanceID/commands`;
  }
  const live = /^\/v1\/sessions\/[^/]+\/(live|live-ticket|commands)(\/[^/]+)?$/.exec(path);
  if (live) return `${request.method} /v1/sessions/:id/${live[1]}${live[2] ? '/:commandID' : ''}`;
  if (/^\/internal\/users\/[^/]+\/erase$/.test(path)) {
    return `${request.method} /internal/users/:id/erase`;
  }
  const match = /^\/v1\/sessions\/[^/]+(?:\/(entities|batches|blobs)(?:\/[^/]+)?)?$/.exec(path);
  return match
    ? `${request.method} /v1/sessions/:id${match[1] ? `/${match[1]}${match[1] === 'blobs' ? '/:hash' : ''}` : ''}`
    : 'not_found';
}

/** Uses declared lengths when present; unknown-length bodies stay streaming. */
export async function instrument(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  fetch: (request: Request) => Response | Promise<Response>
): Promise<Response> {
  let response: Response | undefined;
  let fetching = false;
  let failureLogged = false;
  const logFailure = () => {
    if (failureLogged) return;
    failureLogged = true;
    console.error('Session sync metrics failed');
  };
  try {
    if (!env.SESSION_SYNC_METRICS) {
      fetching = true;
      return fetch(request);
    }
    const started = performance.now();
    const requestBytes = declaredBytes(request.headers);
    const metrics: Metrics = {
      tenant: 'unknown',
      doMs: 0,
      r2Ms: 0,
      sqlMs: 0,
      requestBytes: requestBytes ?? 0,
    };
    const counted =
      request.body && requestBytes === undefined
        ? new Request(request, {
            body: request.body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  metrics.requestBytes += chunk.byteLength;
                  controller.enqueue(chunk);
                },
              })
            ),
          })
        : request;
    requests.set(counted, metrics);
    fetching = true;
    response = await fetch(counted);
    let errorCode = '';
    if (
      request.method !== 'HEAD' &&
      response.status >= 400 &&
      response.headers.get('content-type')?.includes('application/json')
    ) {
      try {
        const body: unknown = await response.clone().json();
        if (body && typeof body === 'object' && 'error' in body) {
          const error = body.error;
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string'
          )
            errorCode = error.code;
        }
      } catch {
        // Error responses need not contain complete JSON.
      }
    }
    const original = response;
    const declaredResponseBytes = declaredBytes(original.headers);
    let responseBytes = declaredResponseBytes ?? 0;
    const normalizedRoute = requestRoute(counted);
    const emit = () => {
      try {
        env.SESSION_SYNC_METRICS?.writeDataPoint({
          indexes: [normalizedRoute],
          blobs: [normalizedRoute, String(original.status), errorCode, metrics.tenant],
          doubles: [
            performance.now() - started,
            metrics.doMs,
            metrics.r2Ms,
            metrics.sqlMs,
            metrics.requestBytes,
            responseBytes,
          ],
        });
      } catch {
        logFailure();
      }
    };
    if (request.method === 'HEAD' || !original.body || declaredResponseBytes !== undefined) {
      emit();
      return original;
    }
    const body = original.body;
    const stream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        responseBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const measured = new Response(stream.readable, original);
    let streaming = false;
    // Do not lock the original body unless background work was registered successfully.
    ctx.waitUntil(
      Promise.resolve().then(() => {
        if (streaming) return body.pipeTo(stream.writable).then(emit, emit);
      })
    );
    streaming = true;
    return measured;
  } catch (error) {
    if (response) {
      logFailure();
      return response;
    }
    if (fetching) throw error;
    logFailure();
    return fetch(request);
  }
}

export type DiagnosticOperation =
  | 'getState'
  | 'register'
  | 'applyBatch'
  | 'readEntities'
  | 'beginBlob'
  | 'abortBlob'
  | 'commitBlob'
  | 'locateBlob'
  | 'deleteSession'
  | 'authorizeLive'
  | 'relayWatch'
  | 'presenceConnect'
  | 'relayConnect'
  | 'syncInitialize'
  | 'relayInitialize'
  | 'presenceInitialize'
  | 'tenantAdmission';
export type DiagnosticStage =
  | 'rpc_lookup'
  | 'rpc'
  | 'tenant_rpc'
  | 'queue_admission'
  | 'queue_wait'
  | 'rate_credit'
  | 'hash'
  | 'receipt_prune'
  | 'validate'
  | 'sql_transaction'
  | 'lease_reserve'
  | 'lease_reapply'
  | 'schedule'
  | 'watch_queue'
  | 'watch_rpc'
  | 'watch_storage'
  | 'watch_budget'
  | 'initialize';
type DiagnosticPoint = {
  operation: DiagnosticOperation;
  stage: DiagnosticStage;
  tenant?: 'user' | 'organization' | 'unknown';
  outcome?: 'ok' | 'error' | 'lease_required' | SyncError['code'];
  cause?: FailureCause;
  durationMs?: number;
  queueDepth?: number;
  retainedBytes?: number;
  error?: unknown;
};
type Aggregate = {
  at: number;
  count: number;
  duration: number;
  depth: number;
  bytes: number;
  overloaded: number;
  retryable: number;
};
const diagnosticFailures = new WeakMap<AnalyticsEngineDataset, Map<string, Aggregate>>();

/**
 * Shares the existing metrics binding. Successes sample 1/128; failures aggregate
 * per bounded key for one second without timers or pending I/O. An idle/evicted
 * isolate may lose its final aggregate, so these are not accounting counters.
 */
export function diagnostic(env: Pick<Env, 'SESSION_SYNC_METRICS'>, point: DiagnosticPoint): void {
  try {
    const binding = env.SESSION_SYNC_METRICS;
    if (!binding) return;
    const outcome = point.outcome ?? (point.error === undefined ? 'ok' : 'error');
    if (outcome === 'ok' && Math.random() >= 1 / 128) return;
    const cause = point.cause ?? (point.error === undefined ? 'none' : failureCause(point.error));
    const blobs = [
      'diagnostic_v1',
      point.operation,
      point.stage,
      outcome,
      cause,
      point.tenant ?? 'unknown',
    ];
    let count = 1;
    let duration = point.durationMs ?? 0;
    let depth = point.queueDepth ?? 0;
    let bytes = point.retainedBytes ?? 0;
    const error = point.error;
    const flags = error !== null && typeof error === 'object' ? error : {};
    let overloaded = 'overloaded' in flags && flags.overloaded === true ? 1 : 0;
    let retryable = 'retryable' in flags && flags.retryable === true ? 1 : 0;
    if (outcome !== 'ok') {
      let keys = diagnosticFailures.get(binding);
      if (!keys) {
        keys = new Map();
        diagnosticFailures.set(binding, keys);
      }
      const key = blobs.join(':');
      const now = Date.now();
      let aggregate = keys.get(key);
      if (!aggregate) {
        if (keys.size >= 128) {
          const oldest = keys.keys().next().value;
          if (oldest !== undefined) keys.delete(oldest);
        }
        aggregate = {
          at: now - 1000,
          count: 0,
          duration: 0,
          depth: 0,
          bytes: 0,
          overloaded: 0,
          retryable: 0,
        };
        keys.set(key, aggregate);
      }
      aggregate.count++;
      aggregate.duration += duration;
      aggregate.depth = Math.max(aggregate.depth, depth);
      aggregate.bytes = Math.max(aggregate.bytes, bytes);
      aggregate.overloaded += overloaded;
      aggregate.retryable += retryable;
      if (now - aggregate.at < 1000) return;
      ({ count, duration, depth, bytes, overloaded, retryable } = aggregate);
      aggregate.at = now;
      aggregate.count =
        aggregate.duration =
        aggregate.depth =
        aggregate.bytes =
        aggregate.overloaded =
        aggregate.retryable =
          0;
    }
    binding.writeDataPoint({
      indexes: ['diagnostic_v1'],
      blobs,
      doubles: [duration, count, depth, bytes, overloaded, retryable, outcome === 'ok' ? 128 : 1],
    });
  } catch {
    // Diagnostics must never change admission, retry, or transport behavior.
  }
}

/** Measures an existing asynchronous boundary without converting its exception. */
export async function phase<T>(
  env: Pick<Env, 'SESSION_SYNC_METRICS'>,
  operation: DiagnosticOperation,
  stage: DiagnosticStage,
  fn: () => Promise<T>,
  tenant?: 'user' | 'organization'
): Promise<T> {
  if (!metricsEnabled(env)) return fn();
  const started = performance.now();
  try {
    const value = await fn();
    diagnostic(env, { operation, stage, tenant, durationMs: performance.now() - started });
    return value;
  } catch (error) {
    diagnostic(env, { operation, stage, tenant, durationMs: performance.now() - started, error });
    throw error;
  }
}

/** Measures synchronous work without introducing an await inside a transaction. */
export function syncPhase<T>(
  env: Pick<Env, 'SESSION_SYNC_METRICS'>,
  operation: DiagnosticOperation,
  stage: DiagnosticStage,
  fn: () => T,
  tenant?: 'user' | 'organization'
): T {
  if (!metricsEnabled(env)) return fn();
  const started = performance.now();
  try {
    const value = fn();
    diagnostic(env, { operation, stage, tenant, durationMs: performance.now() - started });
    return value;
  } catch (error) {
    diagnostic(env, { operation, stage, tenant, durationMs: performance.now() - started, error });
    throw error;
  }
}
