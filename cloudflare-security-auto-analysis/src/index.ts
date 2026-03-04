import { timingSafeEqual as nodeTSE } from 'crypto';
import { consumeOwnerBatch } from './consumer.js';
import { dispatchDueOwners } from './dispatcher.js';

async function sendBetterStackHeartbeat(
  heartbeatUrl: string | undefined,
  failed: boolean
): Promise<void> {
  if (!heartbeatUrl) return;
  const url = failed ? `${heartbeatUrl}/fail` : heartbeatUrl;
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch {
    // best-effort
  }
}

/**
 * Constant-time string equality that does not leak either string's length.
 * Both inputs are hashed first so the comparison is always on equal-length digests.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return nodeTSE(new Uint8Array(digestA), new Uint8Array(digestB));
}

async function handleFetch(request: Request, env: CloudflareEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    return Response.json({
      status: 'ok',
      service: 'security-auto-analysis',
      timestamp: new Date().toISOString(),
    });
  }

  if (request.method === 'POST' && url.pathname === '/internal/dispatch') {
    const internalSecret = await env.INTERNAL_API_SECRET.get();
    const authHeader = request.headers.get('x-internal-api-key');

    if (!authHeader || !internalSecret || !(await timingSafeEqual(authHeader, internalSecret))) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result = await dispatchDueOwners(env);
    return Response.json({
      success: true,
      ...result,
    });
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
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
      await dispatchDueOwners(env);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      ctx.waitUntil(sendBetterStackHeartbeat(env.BETTERSTACK_HEARTBEAT_URL, failed));
    }
  },

  async queue(batch: MessageBatch<unknown>, env: CloudflareEnv): Promise<void> {
    await consumeOwnerBatch(batch, env);
  },
};
