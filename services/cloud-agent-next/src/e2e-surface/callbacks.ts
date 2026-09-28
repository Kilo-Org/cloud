import type { Context } from 'hono';
import { E2E_CALLBACK_TOKEN_TTL_MS, type E2eCallbackSink } from '../persistence/E2eCallbackSink.js';
import type { HonoContext } from '../hono-context.js';
import type { Env } from '../types.js';

/**
 * e2e-only callback routes.
 *
 * The runner mints `{ token, callbackUrl }` with its user JWT, registers
 * `callbackUrl` as a session `callbackTarget`, then reads what the real Worker
 * delivered. The sink is a DO named by the token, so the path token alone
 * addresses one bounded per-token record set.
 *
 * `POST /__e2e/callbacks/:token` is the single route exempt from the secret and
 * JWT gates: `src/callbacks/delivery.ts` sends only `Content-Type` plus
 * `target.headers` and treats a 401 as non-retryable, so ingest must be
 * authorized by its unguessable path token instead. `GET`/`DELETE` require the
 * e2e secret, the user JWT and the recorded owner.
 */

export const E2E_CALLBACK_BODY_LIMIT_BYTES = 64 * 1024;

/** A body read that either fits the limit or was cancelled at the first excess byte. */
export type BoundedBodyResult = { ok: true; bytes: Uint8Array } | { ok: false };

/**
 * Read at most `limit` bytes from `stream`. The first byte over the limit
 * cancels the stream and fails, so a chunked or `Content-Length`-less body is
 * never fully buffered before the limit applies. `null` is an empty body.
 */
export async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  limit: number = E2E_CALLBACK_BODY_LIMIT_BYTES
): Promise<BoundedBodyResult> {
  if (!stream) return { ok: true, bytes: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

function callbackSink(env: Env, token: string): DurableObjectStub<E2eCallbackSink> {
  if (!env.E2E_CALLBACK_SINK) {
    throw new Error('E2E_CALLBACK_SINK binding is not configured');
  }
  return env.E2E_CALLBACK_SINK.getByName(token);
}

function callbackToken(c: Context<HonoContext>): string | undefined {
  const token = c.req.param('token');
  return token && token.length > 0 ? token : undefined;
}

/** `POST /__e2e/callbacks` — mint a token and its delivery URL. */
export async function handleCallbackMint(c: Context<HonoContext>): Promise<Response> {
  const userId = c.get('userId');
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!c.env.E2E_CALLBACK_SINK) {
    return new Response('Callback sink not configured', { status: 503 });
  }

  const token = crypto.randomUUID();
  await callbackSink(c.env, token).register(userId, E2E_CALLBACK_TOKEN_TTL_MS);
  const callbackUrl = new URL(`/__e2e/callbacks/${token}`, new URL(c.req.url).origin).toString();
  return Response.json({ token, callbackUrl });
}

/** `POST /__e2e/callbacks/:token` — token-authorized ingest. */
export async function handleCallbackIngest(c: Context<HonoContext>): Promise<Response> {
  const declaredLength = Number(c.req.header('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > E2E_CALLBACK_BODY_LIMIT_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  const body = await readBoundedBody(c.req.raw.body);
  if (!body.ok) {
    return new Response('Payload too large', { status: 413 });
  }

  const raw = new TextDecoder().decode(body.bytes);
  try {
    JSON.parse(raw);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!c.env.E2E_CALLBACK_SINK) {
    return new Response('Callback sink not configured', { status: 503 });
  }
  const token = callbackToken(c);
  if (!token) return new Response('Unknown or expired callback token', { status: 404 });
  const result = await callbackSink(c.env, token).append(raw);
  if (result.ok) return Response.json({ ok: true });
  if (result.reason === 'full') {
    return new Response('Callback record limit reached', { status: 409 });
  }
  return new Response('Unknown or expired callback token', { status: 404 });
}

/** `GET /__e2e/callbacks/:token` — JWT plus recorded owner. */
export async function handleCallbackRead(c: Context<HonoContext>): Promise<Response> {
  const userId = c.get('userId');
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!c.env.E2E_CALLBACK_SINK) {
    return new Response('Callback sink not configured', { status: 503 });
  }
  const token = callbackToken(c);
  if (!token) return new Response('Unknown or expired callback token', { status: 404 });

  const result = await callbackSink(c.env, token).read(userId);
  if (result.ok) {
    return Response.json({ records: result.records.map(record => JSON.parse(record) as unknown) });
  }
  if (result.reason === 'forbidden') return new Response('Forbidden', { status: 403 });
  return new Response('Unknown or expired callback token', { status: 404 });
}

/** `DELETE /__e2e/callbacks/:token` — JWT plus recorded owner; runner cleanup. */
export async function handleCallbackDelete(c: Context<HonoContext>): Promise<Response> {
  const userId = c.get('userId');
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!c.env.E2E_CALLBACK_SINK) {
    return new Response('Callback sink not configured', { status: 503 });
  }
  const token = callbackToken(c);
  if (!token) return new Response('Unknown or expired callback token', { status: 404 });

  const result = await callbackSink(c.env, token).remove(userId);
  if (result.ok) return new Response(null, { status: 204 });
  if (result.reason === 'forbidden') return new Response('Forbidden', { status: 403 });
  return new Response('Unknown or expired callback token', { status: 404 });
}
