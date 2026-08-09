import { AdmitExportSchema, DownloadRequestSchema } from './contracts';
import type { ExportEnv } from './worker';

async function getInternalApiSecret(secret: ExportEnv['INTERNAL_API_SECRET']): Promise<string> {
  return typeof secret === 'string' ? secret : secret.get();
}

async function authorized(
  request: Request,
  expected: ExportEnv['INTERNAL_API_SECRET']
): Promise<boolean> {
  const received = request.headers.get('x-internal-api-key');
  if (!received) return false;
  const expectedValue = await getInternalApiSecret(expected);
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(received)),
    crypto.subtle.digest('SHA-256', encoder.encode(expectedValue)),
  ]);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

async function readJson(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > 16_384) throw new Error('Request body is too large');
  return request.json<unknown>();
}

export default {
  async fetch(request: Request, env: ExportEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: 'user-data-export' });
    }
    if (!(await authorized(request, env.INTERNAL_API_SECRET))) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    try {
      if (request.method === 'POST' && url.pathname === '/internal/exports/dispatch') {
        const parsed = AdmitExportSchema.safeParse(await readJson(request));
        if (!parsed.success)
          return Response.json({ error: 'Invalid export dispatch' }, { status: 400 });
        await env.EXPORT_QUEUE.send(parsed.data);
        const { createStateDb } = await import('./databases');
        await createStateDb(env.PRIMARY_STATE_DB).markOutboxGenerationSent(
          parsed.data.exportId,
          parsed.data.generation
        );
        return Response.json({ accepted: true }, { status: 202 });
      }
      if (request.method === 'POST' && url.pathname === '/internal/exports/download') {
        const parsed = DownloadRequestSchema.safeParse(await readJson(request));
        if (!parsed.success)
          return Response.json({ error: 'Invalid download request' }, { status: 400 });
        return Response.json(
          { error: 'Download signing is not configured in local Phase 1' },
          { status: 501 }
        );
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch {
      return Response.json({ error: 'Invalid request' }, { status: 400 });
    }
  },
  async queue(batch: MessageBatch<unknown>, env: ExportEnv): Promise<void> {
    const { consumeExportBatch } = await import('./worker');
    await consumeExportBatch(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: ExportEnv): Promise<void> {
    const { reconcile } = await import('./worker');
    await reconcile(env);
  },
} satisfies ExportedHandler<ExportEnv>;
