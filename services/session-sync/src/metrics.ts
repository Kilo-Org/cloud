import type { Env } from './env';

export type Metrics = {
  tenant: string;
  doMs: number;
  r2Ms: number;
  sqlMs: number;
  requestBytes: number;
};
const requests = new WeakMap<Request, Metrics>();

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

function route(request: Request): string {
  const path = new URL(request.url).pathname;
  if (path === '/v1/auth/exchange') return `${request.method} /v1/auth/exchange`;
  const match = /^\/v1\/sessions\/[^/]+(?:\/(entities|batches|blobs)(?:\/[^/]+)?)?$/.exec(path);
  return match
    ? `${request.method} /v1/sessions/:id${match[1] ? `/${match[1]}${match[1] === 'blobs' ? '/:hash' : ''}` : ''}`
    : 'not_found';
}

/** Counts streams without buffering bodies or recording account/session identifiers. */
export async function instrument(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  fetch: (request: Request) => Response | Promise<Response>
): Promise<Response> {
  if (!env.SESSION_SYNC_METRICS) return fetch(request);
  const started = performance.now();
  const metrics: Metrics = { tenant: 'unknown', doMs: 0, r2Ms: 0, sqlMs: 0, requestBytes: 0 };
  const counted = request.body
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
  const response = await fetch(counted);
  let errorCode = '';
  if (
    response.status >= 400 &&
    response.headers.get('content-type')?.includes('application/json')
  ) {
    const body: unknown = await response.clone().json();
    if (body && typeof body === 'object' && 'error' in body) {
      const error = body.error;
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
        errorCode = error.code;
    }
  }
  let responseBytes = 0;
  const emit = () =>
    env.SESSION_SYNC_METRICS?.writeDataPoint({
      indexes: [route(counted)],
      blobs: [route(counted), String(response.status), errorCode, metrics.tenant],
      doubles: [
        performance.now() - started,
        metrics.doMs,
        metrics.r2Ms,
        metrics.sqlMs,
        metrics.requestBytes,
        responseBytes,
      ],
    });
  if (!response.body) {
    emit();
    return response;
  }
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      responseBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  ctx.waitUntil(response.body.pipeTo(stream.writable).then(emit, emit));
  return new Response(stream.readable, response);
}
