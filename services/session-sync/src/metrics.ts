import { Buffer } from 'node:buffer';

import type { Env } from './env';

export type Metrics = {
  tenant: string;
  doMs: number;
  r2Ms: number;
  sqlMs: number;
  requestBytes: number;
};
const requests = new WeakMap<Request, Metrics>();

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
