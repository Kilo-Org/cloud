import { timingSafeEqual as nodeTimingSafeEqual } from 'crypto';
import { getWorkerDb } from '@kilocode/db/client';
import * as z from 'zod';
import { createPromotionStore, syncPromotionsFromBench } from './sync.js';

const SyncRequestSchema = z.object({ promotionName: z.string().min(1).optional() }).optional();

async function sendBetterStackHeartbeat(
  heartbeatUrl: string | undefined,
  failed: boolean
): Promise<void> {
  if (!heartbeatUrl) return;
  const url = failed ? `${heartbeatUrl}/fail` : heartbeatUrl;
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch {
    // best-effort heartbeat
  }
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  return nodeTimingSafeEqual(new Uint8Array(leftDigest), new Uint8Array(rightDigest));
}

async function runSync(env: CloudflareEnv, promotionName?: string) {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
  return syncPromotionsFromBench(env.BENCH_DASHBOARD, createPromotionStore(db), { promotionName });
}

async function getInternalApiSecret(secret: SecretBinding | string): Promise<string> {
  return typeof secret === 'string' ? secret : secret.get();
}

async function handleFetch(request: Request, env: CloudflareEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    return Response.json({
      status: 'ok',
      service: 'model-eval-ingest',
      timestamp: new Date().toISOString(),
    });
  }

  if (request.method !== 'POST' || url.pathname !== '/internal/sync') {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const internalSecret = await getInternalApiSecret(env.INTERNAL_API_SECRET);
  const authHeader = request.headers.get('x-internal-api-key');
  if (!authHeader || !internalSecret || !(await timingSafeEqual(authHeader, internalSecret))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawBody = await request.text();
  let requestBody: unknown;
  try {
    requestBody = rawBody ? JSON.parse(rawBody) : undefined;
  } catch {
    return Response.json({ error: 'Invalid sync request body' }, { status: 400 });
  }

  const parsedBody = SyncRequestSchema.safeParse(requestBody);
  if (!parsedBody.success) {
    return Response.json(
      { error: 'Invalid sync request', issues: parsedBody.error.issues },
      { status: 400 }
    );
  }

  const result = await runSync(env, parsedBody.data?.promotionName);
  return Response.json({ success: true, ...result });
}

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    return handleFetch(request, env);
  },

  async scheduled(
    _controller: ScheduledController,
    env: CloudflareEnv,
    ctx: ExecutionContext
  ): Promise<void> {
    let failed = false;
    try {
      await runSync(env);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      ctx.waitUntil(sendBetterStackHeartbeat(env.BETTERSTACK_HEARTBEAT_URL, failed));
    }
  },
};
