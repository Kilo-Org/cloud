import { withDORetry } from '@kilocode/worker-utils';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';

import { authorize, exchange, type Principal } from './auth';
import { uploadBlob } from './blob-upload';
import { getSessionSyncDOStub, type SessionSyncDO } from './dos/SessionSyncDO';
import type { Env } from './env';
import { internal } from './internal';
import { isOverloaded, overloaded, rpcError, ServiceOverloaded } from './overload';
import {
  ERROR_STATUS,
  LIMITS,
  decodeCursor,
  errorBody,
  fail,
  hashSchema,
  ok,
  pageQuerySchema,
  registerRequestSchema,
  sessionIDSchema,
  type Result,
  type SyncError,
} from './protocol';
import { rateLimit } from './rate-limit';
import {
  diagnostic,
  phase,
  jsonResponse,
  requestMetrics,
  requestRoute,
  timed,
  type DiagnosticOperation,
} from './metrics';
import { live } from './live/routes';
import { LiveTicketError } from './live/ticket';

type AppContext = { Bindings: Env; Variables: { principal: Principal } };
type C = Context<AppContext>;

function json(body: unknown, status: number): Response {
  return jsonResponse(body, { status, headers: { 'cache-control': 'no-store' } });
}

function failure(error: SyncError): Response {
  const response = json(errorBody(error), ERROR_STATUS[error.code]);
  if (error.code === 'tenant_unavailable') response.headers.set('Retry-After', '60');
  if (error.code === 'rate_limited') response.headers.set('Retry-After', '60');
  if (error.code === 'service_overloaded') response.headers.set('Retry-After', '3');
  return response;
}

function respond<T>(result: Result<T>): Response {
  return result.ok ? json(result.value, 200) : failure(result.error);
}

function invalid(error: z.ZodError): SyncError {
  return { code: 'invalid_request', message: z.prettifyError(error).slice(0, 2000) };
}

/** Calls the session object of the authenticated tenant with retries for transient failures. */
async function call<T>(
  c: C,
  sessionID: string,
  operation: (stub: DurableObjectStub<SessionSyncDO>) => Promise<Result<T>>,
  name: DiagnosticOperation
): Promise<Result<T>> {
  const tenant = c.get('principal').tenant;
  return timed(c.req.raw, 'doMs', async () => {
    const result = await withDORetry(
      () => {
        try {
          return getSessionSyncDOStub(c.env, { tenant, sessionID });
        } catch (error) {
          diagnostic(c.env, { operation: name, stage: 'rpc_lookup', tenant: tenant.type, error });
          throw rpcError(error);
        }
      },
      async stub => {
        try {
          return await phase(c.env, name, 'rpc', () => operation(stub), tenant.type);
        } catch (error) {
          throw rpcError(error);
        }
      },
      `SessionSyncDO.${name}`
    ).catch((error: unknown) => {
      if (error instanceof ServiceOverloaded) return overloaded();
      throw error;
    });
    if (!result.ok) {
      diagnostic(c.env, {
        operation: name,
        stage: 'rpc',
        tenant: tenant.type,
        outcome: result.error.code,
        cause: 'typed_result',
      });
    }
    const metrics = requestMetrics(c.req.raw);
    if (
      metrics &&
      result &&
      typeof result === 'object' &&
      'r2Ms' in result &&
      typeof result.r2Ms === 'number'
    )
      metrics.r2Ms += result.r2Ms;
    return result;
  });
}

function declaredLength(request: Request): number | undefined {
  const header = request.headers.get('content-length');
  if (header === null || !/^\d+$/.test(header)) return undefined;
  return Number(header);
}

/** Reads a bounded body as exact UTF-8 text; a byte-order mark stays part of the text. */
async function readText(request: Request, max: number): Promise<Result<string>> {
  const declared = declaredLength(request);
  if (declared !== undefined && declared > max) {
    return fail('request_too_large', `The body exceeds ${max} bytes`);
  }
  if (!request.body) return fail('invalid_request', 'A JSON body is required');
  const read = await readBoundedStream(request.body as ReadableStream<Uint8Array>, max);
  if (!read.ok) return fail('request_too_large', `The body exceeds ${max} bytes`);
  try {
    return ok(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes));
  } catch {
    return fail('invalid_request', 'The body is not valid UTF-8');
  }
}

async function readJson(request: Request, max: number): Promise<Result<unknown>> {
  const text = await readText(request, max);
  if (!text.ok) return text;
  try {
    const value: unknown = JSON.parse(text.value);
    return ok(value);
  } catch {
    return fail('invalid_request', 'The body is not valid JSON');
  }
}

/** Consumes a retry body without canceling its reusable HTTP connection. */
async function discard(body: ReadableStream<Uint8Array>, bytes: number): Promise<Result<null>> {
  const signal = AbortSignal.timeout(LIMITS.uploadMs);
  try {
    await body
      .pipeThrough(new FixedLengthStream(bytes))
      .pipeTo(new WritableStream<Uint8Array>(), { signal });
    return ok(null);
  } catch {
    return signal.aborted
      ? fail('upload_timeout', 'The upload did not finish in time')
      : fail('invalid_request', 'The body does not match Content-Length');
  }
}

function sessionParam(c: C): Result<string> {
  const parsed = sessionIDSchema.safeParse(c.req.param('id'));
  return parsed.success ? ok(parsed.data) : fail('invalid_request', 'Invalid session ID');
}

export const app = new Hono<AppContext>();

const browserCors = cors({
  origin: (origin, c: C) =>
    ['https://kilo.ai', 'https://app.kilo.ai'].includes(origin) ||
    (c.env.ENVIRONMENT === 'development' && origin === 'http://localhost:3000')
      ? origin
      : null,
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Retry-After'],
  maxAge: 86400,
});
app.use('/v1/*', (c: C, next: Next) =>
  c.req.header('Upgrade')?.toLowerCase() === 'websocket' ? next() : browserCors(c, next)
);

app.route('/internal', internal);

app.post('/v1/auth/exchange', c => exchange(c.req.raw, c.env));
app.route('/v1', live);

app.use('/v1/sessions/*', async (c, next) => {
  const principal = await authorize(c.req.raw, c.env);
  if (principal instanceof Response) return principal;
  c.set('principal', principal);
  const metrics = requestMetrics(c.req.raw);
  if (metrics) metrics.tenant = principal.tenant.type;
  // Reads and batches buy request credits in their session object.
  if (c.req.method === 'PUT' || c.req.method === 'DELETE') {
    const denied = await rateLimit(c.env.USER_REQUEST_LIMITER, principal.userID);
    if (denied) return denied;
  }
  if (c.req.method === 'PUT' && /^\/v1\/sessions\/[^/]+\/blobs\/[^/]+$/.test(c.req.path)) {
    const blobDenied = await rateLimit(c.env.USER_BLOB_LIMITER, principal.userID);
    if (blobDenied) return blobDenied;
  }
  await next();
});

app.get('/v1/sessions/:id', async c => {
  const sessionID = sessionParam(c);
  if (!sessionID.ok) return failure(sessionID.error);
  const input = { principal: c.get('principal'), sessionID: sessionID.value };
  return respond(await call(c, input.sessionID, async s => await s.getState(input), 'getState'));
});

app.put('/v1/sessions/:id', async c => {
  const sessionID = sessionParam(c);
  if (!sessionID.ok) return failure(sessionID.error);
  const body = await readJson(c.req.raw, LIMITS.controlBytes);
  if (!body.ok) return failure(body.error);
  const request = registerRequestSchema.safeParse(body.value);
  if (!request.success) return failure(invalid(request.error));
  const input = {
    principal: c.get('principal'),
    sessionID: sessionID.value,
    request: request.data,
  };
  const result = await call(c, input.sessionID, async s => await s.register(input), 'register');
  if (!result.ok) return failure(result.error);
  return json(result.value.state, result.value.created ? 201 : 200);
});

app.delete('/v1/sessions/:id', async c => {
  const sessionID = sessionParam(c);
  if (!sessionID.ok) return failure(sessionID.error);
  const input = { principal: c.get('principal'), sessionID: sessionID.value };
  return respond(
    await call(c, input.sessionID, async s => await s.deleteSession(input), 'deleteSession')
  );
});

app.post('/v1/sessions/:id/batches', async c => {
  const sessionID = sessionParam(c);
  if (!sessionID.ok) return failure(sessionID.error);
  // The DO validates and hashes the exact body, so a retry must repeat it verbatim.
  const body = await readText(c.req.raw, LIMITS.batchBytes);
  if (!body.ok) return failure(body.error);
  const input = { principal: c.get('principal'), sessionID: sessionID.value, body: body.value };
  return respond(
    await call(c, input.sessionID, async s => await s.applyBatch(input), 'applyBatch')
  );
});

app.get('/v1/sessions/:id/entities', async c => {
  const sessionID = sessionParam(c);
  if (!sessionID.ok) return failure(sessionID.error);
  const query = pageQuerySchema.safeParse(c.req.query());
  if (!query.success) return failure(invalid(query.error));
  const cursor = query.data.cursor === undefined ? undefined : decodeCursor(query.data.cursor);
  if (query.data.cursor !== undefined && cursor === undefined) {
    return failure({ code: 'invalid_request', message: 'Invalid page cursor' });
  }
  const input = {
    principal: c.get('principal'),
    sessionID: sessionID.value,
    cursor,
    limit: query.data.limit ?? LIMITS.pageDefault,
    revision: query.data.revision,
  };
  const result = await call(
    c,
    input.sessionID,
    async s => await s.readEntities(input),
    'readEntities'
  );
  if (!result.ok) return failure(result.error);
  return new Response(result.value, {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
});

app.put('/v1/sessions/:id/blobs/:hash', async c => {
  const sessionID = sessionParam(c);
  if (!sessionID.ok) return failure(sessionID.error);
  const hash = hashSchema.safeParse(c.req.param('hash'));
  if (!hash.success) return failure({ code: 'invalid_request', message: 'Invalid blob hash' });
  const bytes = declaredLength(c.req.raw);
  if (bytes === undefined) {
    return failure({ code: 'length_required', message: 'Content-Length is required' });
  }
  if (bytes > LIMITS.blobBytes) {
    return failure({
      code: 'request_too_large',
      message: `The blob exceeds ${LIMITS.blobBytes} bytes`,
    });
  }

  const input = {
    principal: c.get('principal'),
    sessionID: sessionID.value,
    blob: { hash: hash.data, bytes },
  };
  const begun = await call(c, input.sessionID, async s => await s.beginBlob(input), 'beginBlob');
  if (!begun.ok) return failure(begun.error);
  const body = (c.req.raw.body ?? new Blob([]).stream()) as ReadableStream<Uint8Array>;
  if (begun.value.status === 'ready') {
    const consumed = await discard(body, bytes);
    if (!consumed.ok) return failure(consumed.error);
    return json({ version: 1, hash: hash.data, bytes, created: false }, 200);
  }
  const upload = begun.value;
  const attemptInput = { ...input, attempt: begun.value.attempt };

  let uploaded: Result<null>;
  try {
    uploaded = await timed(c.req.raw, 'r2Ms', () =>
      uploadBlob(c.env.SESSION_SYNC_R2, upload, body, hash.data, bytes)
    );
  } catch (error) {
    await call(c, input.sessionID, async s => await s.abortBlob(attemptInput), 'abortBlob');
    throw error;
  }
  if (!uploaded.ok) {
    await call(c, input.sessionID, async s => await s.abortBlob(attemptInput), 'abortBlob');
    return failure(uploaded.error);
  }

  const committed = await call(
    c,
    input.sessionID,
    async s => await s.commitBlob(attemptInput),
    'commitBlob'
  );
  if (!committed.ok) return failure(committed.error);
  return json(committed.value, committed.value.created ? 201 : 200);
});

app.get('/v1/sessions/:id/blobs/:hash', async c => {
  const sessionID = sessionParam(c);
  if (!sessionID.ok) return failure(sessionID.error);
  const hash = hashSchema.safeParse(c.req.param('hash'));
  if (!hash.success) return failure({ code: 'invalid_request', message: 'Invalid blob hash' });
  const input = { principal: c.get('principal'), sessionID: sessionID.value, hash: hash.data };
  const located = await call(
    c,
    input.sessionID,
    async s => await s.locateBlob(input),
    'locateBlob'
  );
  if (!located.ok) return failure(located.error);
  const object = await timed(c.req.raw, 'r2Ms', () => c.env.SESSION_SYNC_R2.get(located.value.key));
  if (!object) {
    return failure({ code: 'blob_not_found', message: 'The blob is not stored for this session' });
  }
  return new Response(object.body, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(object.size),
      'cache-control': 'private, no-store',
      'x-content-sha256': hash.data,
    },
  });
});

app.notFound(() => failure({ code: 'not_found', message: 'Route not found' }));

app.onError((error, c) => {
  if (isOverloaded(error)) {
    return failure({
      code: 'service_overloaded',
      message: 'The service is temporarily overloaded',
    });
  }
  if (error instanceof LiveTicketError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  console.error('session-sync request failed', {
    path: requestRoute(c.req.raw),
    error: error.name,
  });
  return failure({ code: 'internal_error', message: 'Internal error' });
});
