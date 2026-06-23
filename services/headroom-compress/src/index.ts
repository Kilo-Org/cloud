import { Hono } from 'hono';
import { createErrorHandler } from '@kilocode/worker-utils';
import { authMiddleware } from './auth';
import { ConfigError, loadConfig } from './config';
import { HttpError, readJsonBodyWithLimit, validateCompressRequest } from './guards';
import type { CompressRequestBody } from './guards';
import type { HonoEnv } from './hono-env';

export { HeadroomContainer } from './headroom-container';

const SERVICE = 'headroom-compress';

export const app = new Hono<HonoEnv>();

app.get('/readyz', c => {
  try {
    const config = loadConfig(c.env);
    return c.json({
      status: 'ok',
      service: SERVICE,
      models: config.modelAllowlist.size,
      instances: config.instanceCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'headroom_readyz_config_error', error: message }));
    return jsonResponse(500, {
      error: { type: 'configuration_error', message: 'Headroom Worker is misconfigured.' },
    });
  }
});

app.post('/v1/compress', authMiddleware, async c => {
  const requestId = getRequestId(c.req.raw);
  const startedAt = Date.now();

  try {
    const config = loadConfig(c.env);
    const { json, byteLength } = await readJsonBodyWithLimit(c.req.raw, config.maxBodyBytes);
    const body = validateCompressRequest(json, config);
    const containerIndex = randomInstanceIndex(config.instanceCount);
    const response = await forwardCompressRequest({
      env: c.env,
      body,
      requestId,
      containerIndex,
      timeoutMs: config.containerRequestTimeoutMs,
    });

    console.log(
      JSON.stringify({
        event: 'headroom_compress_completed',
        request_id: requestId,
        model: body.model,
        request_bytes: byteLength,
        status: response.status,
        duration_ms: Date.now() - startedAt,
        container_index: containerIndex,
      })
    );

    return filterContainerResponse(response, requestId);
  } catch (error) {
    return handleCompressError(error, requestId, startedAt);
  }
});

app.all('*', c => {
  console.log(
    JSON.stringify({
      event: 'headroom_route_rejected',
      method: c.req.method,
      path: new URL(c.req.url).pathname,
    })
  );
  return jsonResponse(404, { error: { type: 'not_found', message: 'Not found.' } });
});

app.onError(createErrorHandler(console, { includeMessage: false }));

export default { fetch: app.fetch };

type ForwardArgs = {
  env: Env;
  body: CompressRequestBody;
  requestId: string;
  containerIndex: number;
  timeoutMs: number;
};

async function forwardCompressRequest({
  env,
  body,
  requestId,
  containerIndex,
  timeoutMs,
}: ForwardArgs): Promise<Response> {
  const containerId = env.HEADROOM_CONTAINER.idFromName(`headroom-${containerIndex}`);
  const container = env.HEADROOM_CONTAINER.get(containerId);
  const request = new Request('http://headroom.local/v1/compress', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  return await container.fetch(request);
}

function filterContainerResponse(response: Response, requestId: string): Response {
  const headers = new Headers();
  headers.set('cache-control', 'no-store');
  headers.set('x-request-id', requestId);
  const contentType = response.headers.get('content-type');
  if (contentType) {
    headers.set('content-type', contentType);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function handleCompressError(error: unknown, requestId: string, startedAt: number): Response {
  if (error instanceof HttpError) {
    console.warn(
      JSON.stringify({
        event: 'headroom_compress_rejected',
        request_id: requestId,
        status: error.status,
        type: error.code,
        duration_ms: Date.now() - startedAt,
      })
    );
    return jsonResponse(error.status, error.toBody(), requestId);
  }

  if (error instanceof ConfigError) {
    console.error(
      JSON.stringify({
        event: 'headroom_compress_config_error',
        request_id: requestId,
        error: error.message,
      })
    );
    return jsonResponse(
      500,
      { error: { type: 'configuration_error', message: 'Headroom Worker is misconfigured.' } },
      requestId
    );
  }

  const isTimeout =
    error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
  const status = isTimeout ? 504 : 502;
  const type = isTimeout ? 'container_timeout' : 'container_error';
  const message = isTimeout
    ? 'Headroom compression timed out.'
    : 'Headroom container request failed.';
  console.error(
    JSON.stringify({
      event: 'headroom_compress_failed',
      request_id: requestId,
      type,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startedAt,
    })
  );
  return jsonResponse(status, { error: { type, message } }, requestId);
}

function jsonResponse(status: number, body: unknown, requestId?: string): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  if (requestId) {
    headers.set('x-request-id', requestId);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function getRequestId(request: Request): string {
  return (
    request.headers.get('x-request-id') ?? request.headers.get('cf-ray') ?? crypto.randomUUID()
  );
}

function randomInstanceIndex(instanceCount: number): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] % instanceCount;
}
