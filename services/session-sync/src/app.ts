import { withDORetry } from '@kilocode/worker-utils';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { authorize, exchange, type Principal } from './auth';
import { uploadBlob } from './blob-upload';
import { getSessionSyncDOStub, type SessionSyncDO } from './dos/SessionSyncDO';
import type { Env } from './env';
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

type AppContext = { Bindings: Env; Variables: { principal: Principal } };
type C = Context<AppContext>;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function failure(error: SyncError): Response {
  return json(errorBody(error), ERROR_STATUS[error.code]);
}

function respond<T>(result: Result<T>): Response {
  return result.ok ? json(result.value, 200) : failure(result.error);
}

function invalid(error: z.ZodError): SyncError {
  return { code: 'invalid_request', message: z.prettifyError(error).slice(0, 2000) };
}

/** Calls the session object of the authenticated tenant with retries for transient failures. */
function call<T>(
  c: C,
  sessionID: string,
  operation: (stub: DurableObjectStub<SessionSyncDO>) => Promise<T>,
  name: string
): Promise<T> {
  const tenant = c.get('principal').tenant;
  return withDORetry(
    () => getSessionSyncDOStub(c.env, { tenant, sessionID }),
    operation,
    `SessionSyncDO.${name}`
  );
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

app.post('/v1/auth/exchange', c => exchange(c.req.raw, c.env));

app.use('/v1/sessions/*', async (c, next) => {
  const principal = await authorize(c.req.raw, c.env);
  if (principal instanceof Response) return principal;
  c.set('principal', principal);
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
  const attemptInput = { ...input, attempt: begun.value.attempt };

  let uploaded: Result<null>;
  try {
    uploaded = await uploadBlob(c.env.SESSION_SYNC_R2, begun.value, body, hash.data, bytes);
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
  const object = await c.env.SESSION_SYNC_R2.get(located.value.key);
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
  console.error('session-sync request failed', {
    path: new URL(c.req.url).pathname,
    error: error.name,
  });
  return failure({ code: 'internal_error', message: 'Internal error' });
});
