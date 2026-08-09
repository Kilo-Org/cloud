import { AdmitExportSchema, DownloadRequestSchema } from './contracts';
import type { ExportEnv } from './worker';
import type { ExportQueueMessage } from './contracts';
import type { StateDb } from './databases';
import { createR2Client } from '@kilocode/worker-utils/r2-client';
import { verifyKiloToken } from '@kilocode/worker-utils/kilo-token';
import { extractBearerToken } from '@kilocode/worker-utils';
import {
  USER_DATA_EXPORT_ASSERTION_TTL_SECONDS,
  USER_DATA_EXPORT_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';

const DOWNLOAD_EXPIRES_SECONDS = 300;
const DOWNLOAD_CONTENT_DISPOSITION = 'attachment; filename="kilo-data-export.jsonl.gz"';
const MAX_INTERNAL_REQUEST_BYTES = 16_384;

function downloadExpiration(objectExpiresAt: string, now: number = Date.now()) {
  const remainingSeconds = Math.floor((new Date(objectExpiresAt).getTime() - now) / 1000);
  if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) return null;
  const expiresIn = Math.min(DOWNLOAD_EXPIRES_SECONDS, remainingSeconds);
  return { expiresIn, expiresAt: new Date(now + expiresIn * 1000).toISOString() };
}

async function authorized(request: Request, expected: string): Promise<boolean> {
  const received = request.headers.get('x-internal-api-key');
  if (!received) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(received)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

async function authenticatedUserId(request: Request, env: ExportEnv): Promise<string | null> {
  if (!(await authorized(request, env.INTERNAL_API_SECRET))) return null;
  const token = extractBearerToken(request.headers.get('authorization'));
  if (!token) return null;
  try {
    const payload = await verifyKiloToken(token, env.NEXTAUTH_SECRET, {
      audience: USER_DATA_EXPORT_AUDIENCE,
    });
    const now = Math.floor(Date.now() / 1000);
    if (
      payload.iat === undefined ||
      payload.exp === undefined ||
      payload.iat > now + 30 ||
      payload.exp - payload.iat > USER_DATA_EXPORT_ASSERTION_TTL_SECONDS
    ) {
      return null;
    }
    return payload.kiloUserId;
  } catch {
    return null;
  }
}

async function dispatchExport(
  message: ExportQueueMessage,
  kiloUserId: string,
  state: Pick<StateDb, 'exportBelongsToUser' | 'markOutboxGenerationSent'>,
  queue: Pick<Queue<ExportQueueMessage>, 'send'>
): Promise<'accepted' | 'not_found'> {
  if (!(await state.exportBelongsToUser(message.exportId, kiloUserId))) return 'not_found';
  await queue.send(message);
  await state.markOutboxGenerationSent(message.exportId, message.generation);
  return 'accepted';
}

async function readJson(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > MAX_INTERNAL_REQUEST_BYTES)
    throw new Error('Request body is too large');
  if (!request.body) return null;
  const bodyStream = request.body as ReadableStream<Uint8Array>;
  const reader = bodyStream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_INTERNAL_REQUEST_BYTES) {
      await reader.cancel('Request body is too large');
      throw new Error('Request body is too large');
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

export default {
  async fetch(request: Request, env: ExportEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: 'user-data-export' });
    }
    const kiloUserId = await authenticatedUserId(request, env);
    if (!kiloUserId) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    try {
      if (request.method === 'POST' && url.pathname === '/internal/exports/dispatch') {
        const parsed = AdmitExportSchema.safeParse(await readJson(request));
        if (!parsed.success)
          return Response.json({ error: 'Invalid export dispatch' }, { status: 400 });
        const { createStateDb } = await import('./databases');
        const state = createStateDb(env.PRIMARY_STATE_DB);
        if (
          (await dispatchExport(parsed.data, kiloUserId, state, env.EXPORT_QUEUE)) === 'not_found'
        ) {
          return Response.json({ error: 'Export not found' }, { status: 404 });
        }
        return Response.json({ accepted: true }, { status: 202 });
      }
      if (request.method === 'POST' && url.pathname === '/internal/exports/download') {
        const parsed = DownloadRequestSchema.safeParse(await readJson(request));
        if (!parsed.success)
          return Response.json({ error: 'Invalid download request' }, { status: 400 });
        const { createStateDb } = await import('./databases');
        const object = await createStateDb(env.PRIMARY_STATE_DB).readyObject(
          parsed.data.exportId,
          kiloUserId
        );
        if (!object) return Response.json({ error: 'Export not found' }, { status: 404 });
        const expiration = downloadExpiration(object.expires_at);
        if (!expiration) return Response.json({ error: 'Export not found' }, { status: 404 });
        const signer = createR2Client({
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        });
        const downloadUrl = await signer.getSignedURL(
          env.R2_BUCKET_NAME,
          object.r2_object_key,
          expiration.expiresIn,
          { responseContentDisposition: DOWNLOAD_CONTENT_DISPOSITION }
        );
        return Response.json(
          { downloadUrl, expiresAt: expiration.expiresAt },
          { headers: { 'cache-control': 'private, no-store' } }
        );
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch {
      return Response.json({ error: 'Invalid request' }, { status: 400 });
    }
  },
  async queue(batch: MessageBatch<unknown>, env: ExportEnv): Promise<void> {
    const { consumeDeadLetterBatch, consumeExportBatch } = await import('./worker');
    if (batch.queue.endsWith('-dlq')) await consumeDeadLetterBatch(batch, env);
    else await consumeExportBatch(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: ExportEnv): Promise<void> {
    const { reconcile } = await import('./worker');
    await reconcile(env);
  },
} satisfies ExportedHandler<ExportEnv>;

export const __test__ = { downloadExpiration, readJson, authenticatedUserId, dispatchExport };
