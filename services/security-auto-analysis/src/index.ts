import { timingSafeEqual as nodeTSE } from 'crypto';
import { verifyCallbackToken } from '@kilocode/worker-utils';
import { consumeOwnerBatch } from './consumer.js';
import { dispatchDueOwners } from './dispatcher.js';
import {
  consumeAnalysisCallbackBatch,
  SecurityAnalysisCallbackPayloadSchema,
} from './callbacks.js';
import { consumeManualAnalysisBatch, ManualAnalysisStartCommandSchema } from './manual-analysis.js';

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

  if (request.method === 'POST' && url.pathname === '/internal/manual-analysis-start') {
    if (env.MANUAL_ANALYSIS_COMMAND_ROUTING_ENABLED === 'false') {
      return Response.json(
        { error: 'Manual analysis Worker routing is disabled' },
        { status: 503 }
      );
    }
    const internalSecret = await env.INTERNAL_API_SECRET.get();
    const authHeader = request.headers.get('x-internal-api-key');
    if (!authHeader || !internalSecret || !(await timingSafeEqual(authHeader, internalSecret))) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsedPayload = ManualAnalysisStartCommandSchema.safeParse(payload);
    if (!parsedPayload.success) {
      return Response.json(
        { error: 'Invalid manual analysis command', issues: parsedPayload.error.issues },
        { status: 400 }
      );
    }
    await env.MANUAL_ANALYSIS_QUEUE.sendBatch([{ body: parsedPayload.data, contentType: 'json' }]);
    return Response.json({ success: true, accepted: true }, { status: 202 });
  }

  const callbackMatch = url.pathname.match(
    /^\/internal\/security-analysis-callback\/([0-9a-fA-F-]+)$/
  );
  if (request.method === 'POST' && callbackMatch) {
    if (env.SECURITY_ANALYSIS_CALLBACK_WORKER_INGRESS_ENABLED === 'false') {
      return Response.json(
        { error: 'Security analysis Worker callback ingress is disabled' },
        { status: 503 }
      );
    }
    const findingId = callbackMatch[1];
    if (!findingId) {
      return Response.json({ error: 'Missing finding id' }, { status: 400 });
    }
    const attemptToken = url.searchParams.get('attempt');
    if (!attemptToken) {
      return Response.json({ error: 'Missing callback attempt token' }, { status: 400 });
    }
    const callbackTokenSecret = await env.CALLBACK_TOKEN_SECRET.get();
    const callbackToken = request.headers.get('X-Callback-Token');
    const validCallbackToken =
      !!callbackTokenSecret &&
      (await verifyCallbackToken({
        token: callbackToken,
        secret: callbackTokenSecret,
        scope: 'security-analysis-callback',
        resourceParts: [findingId, attemptToken],
      }));
    if (!validCallbackToken) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsedPayload = SecurityAnalysisCallbackPayloadSchema.safeParse(payload);
    if (!parsedPayload.success) {
      return Response.json(
        { error: 'Invalid callback payload', issues: parsedPayload.error.issues },
        { status: 400 }
      );
    }

    await env.CALLBACK_QUEUE.sendBatch([
      {
        body: { findingId, attemptToken, payload: parsedPayload.data },
        contentType: 'json',
      },
    ]);
    return Response.json({ success: true, accepted: true }, { status: 202 });
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
    if (batch.queue.startsWith('security-auto-analysis-callback-queue')) {
      await consumeAnalysisCallbackBatch(batch, env);
      return;
    }
    if (batch.queue.startsWith('security-manual-analysis-command-queue')) {
      await consumeManualAnalysisBatch(batch, env);
      return;
    }
    await consumeOwnerBatch(batch, env);
  },
};
