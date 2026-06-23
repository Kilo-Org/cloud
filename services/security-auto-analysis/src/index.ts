import { randomUUID, timingSafeEqual as nodeTSE } from 'crypto';
import {
  createSecurityAgentCommand,
  markSecurityAgentCommandQueueAdmissionFailed,
  type SecurityAgentCommandOwner,
} from '@kilocode/db';
import { getWorkerDb } from '@kilocode/db/client';
import { verifyCallbackToken } from '@kilocode/worker-utils';
import { consumeOwnerBatch } from './consumer.js';
import { dispatchDueOwners } from './dispatcher.js';
import { logger, sanitizedExceptionName } from './logger.js';
import {
  consumeAnalysisCallbackBatch,
  SecurityAnalysisCallbackPayloadSchema,
} from './callbacks.js';
import { consumeManualAnalysisBatch, ManualAnalysisStartRequestSchema } from './manual-analysis.js';
import {
  ApplyAutoRemediationCommandSchema,
  CancelRemediationRequestSchema,
  consumeApplyAutoRemediationBatch,
  consumeRemediationAttemptBatch,
  consumeRemediationCallbackBatch,
  ManualRemediationStartRequestSchema,
  SecurityRemediationCallbackPayloadSchema,
  cancelRemediation,
  startManualRemediation,
} from './remediation.js';

const HEARTBEAT_EVENT = 'security_auto_analysis.heartbeat_delivery';

async function sendBetterStackHeartbeat(options: {
  heartbeatUrl: string | undefined;
  dispatcherFailed: boolean;
  dispatchId: string | undefined;
  env: CloudflareEnv;
}): Promise<void> {
  const heartbeatKind = options.dispatcherFailed ? 'failure' : 'success';
  const commonTags = {
    event_name: HEARTBEAT_EVENT,
    heartbeat_kind: heartbeatKind,
    dispatch_id: options.dispatchId,
    worker_environment: options.env.ENVIRONMENT,
    worker_version: options.env.CF_VERSION_METADATA?.id,
  } as const;

  if (!options.heartbeatUrl) {
    logger.withTags({ ...commonTags, outcome: 'skipped' }).warn(HEARTBEAT_EVENT);
    return;
  }

  const startedAt = Date.now();
  logger.withTags({ ...commonTags, outcome: 'attempted' }).info(HEARTBEAT_EVENT);

  try {
    const url = options.dispatcherFailed ? `${options.heartbeatUrl}/fail` : options.heartbeatUrl;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const responseTags = {
      ...commonTags,
      elapsed_ms: Date.now() - startedAt,
      response_status: response.status,
      response_status_class: `${Math.floor(response.status / 100)}xx`,
    };
    if (response.ok) {
      logger.withTags({ ...responseTags, outcome: 'succeeded' }).info(HEARTBEAT_EVENT);
      return;
    }

    logger.withTags({ ...responseTags, outcome: 'failed' }).warn(HEARTBEAT_EVENT);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    logger
      .withTags({
        ...commonTags,
        outcome: timedOut ? 'timeout' : 'failed',
        exception_name: sanitizedExceptionName(error),
        error_message: timedOut ? 'Heartbeat delivery timed out' : 'Heartbeat network failure',
        elapsed_ms: Date.now() - startedAt,
      })
      .warn(HEARTBEAT_EVENT);
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
    const parsedPayload = ManualAnalysisStartRequestSchema.safeParse(payload);
    if (!parsedPayload.success) {
      return Response.json(
        { error: 'Invalid manual analysis command', issues: parsedPayload.error.issues },
        { status: 400 }
      );
    }
    const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
    const owner: SecurityAgentCommandOwner = parsedPayload.data.owner.organizationId
      ? { type: 'org', id: parsedPayload.data.owner.organizationId }
      : { type: 'user', id: parsedPayload.data.owner.userId ?? parsedPayload.data.actorUserId };
    const command = await createSecurityAgentCommand(db, {
      commandType: 'start_analysis',
      origin: 'manual',
      owner,
      findingId: parsedPayload.data.findingId,
    });
    try {
      await env.MANUAL_ANALYSIS_QUEUE.sendBatch([
        { body: { ...parsedPayload.data, commandId: command.id }, contentType: 'json' },
      ]);
    } catch (error) {
      await markSecurityAgentCommandQueueAdmissionFailed(db, command.id, 'Queue admission failed');
      throw error;
    }
    return Response.json({ success: true, accepted: true, commandId: command.id }, { status: 202 });
  }

  if (request.method === 'POST' && url.pathname === '/internal/remediation/start') {
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
    const parsedPayload = ManualRemediationStartRequestSchema.safeParse(payload);
    if (!parsedPayload.success) {
      return Response.json(
        { error: 'Invalid remediation command', issues: parsedPayload.error.issues },
        { status: 400 }
      );
    }

    const result = await startManualRemediation({ env, request: parsedPayload.data });
    if (!result.admitted) {
      return Response.json(
        { success: false, accepted: false, admitted: false, reason: result.reason },
        { status: result.reason === 'finding_not_found' ? 404 : 409 }
      );
    }
    return Response.json(
      {
        success: true,
        accepted: true,
        admitted: true,
        remediationId: result.remediationId,
        attemptId: result.attemptId,
        attemptNumber: result.attemptNumber,
      },
      { status: 202 }
    );
  }

  if (request.method === 'POST' && url.pathname === '/internal/remediation/cancel') {
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
    const parsedPayload = CancelRemediationRequestSchema.safeParse(payload);
    if (!parsedPayload.success) {
      return Response.json(
        { error: 'Invalid remediation cancellation', issues: parsedPayload.error.issues },
        { status: 400 }
      );
    }

    const result = await cancelRemediation({ env, request: parsedPayload.data });
    return Response.json(result, { status: 202 });
  }

  if (request.method === 'POST' && url.pathname === '/internal/apply-auto-remediation') {
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
    const parsedPayload = ApplyAutoRemediationCommandSchema.safeParse(payload);
    if (!parsedPayload.success) {
      return Response.json(
        { error: 'Invalid apply auto-remediation command', issues: parsedPayload.error.issues },
        { status: 400 }
      );
    }

    try {
      await env.REMEDIATION_COMMAND_QUEUE.sendBatch([
        { body: parsedPayload.data, contentType: 'json' },
      ]);
    } catch (error) {
      const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
      await markSecurityAgentCommandQueueAdmissionFailed(
        db,
        parsedPayload.data.commandId,
        'Queue admission failed'
      );
      throw error;
    }
    return Response.json(
      { success: true, accepted: true, commandId: parsedPayload.data.commandId },
      { status: 202 }
    );
  }

  const remediationCallbackMatch = url.pathname.match(
    /^\/internal\/security-remediation-callback\/([0-9a-fA-F-]+)$/
  );
  if (request.method === 'POST' && remediationCallbackMatch) {
    if (env.SECURITY_ANALYSIS_CALLBACK_WORKER_INGRESS_ENABLED === 'false') {
      return Response.json(
        { error: 'Security remediation Worker callback ingress is disabled' },
        { status: 503 }
      );
    }
    const attemptId = remediationCallbackMatch[1];
    if (!attemptId) {
      return Response.json({ error: 'Missing remediation attempt id' }, { status: 400 });
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
        scope: 'security-remediation-callback',
        resourceParts: [attemptId, attemptToken],
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

    const parsedPayload = SecurityRemediationCallbackPayloadSchema.safeParse(payload);
    if (!parsedPayload.success) {
      return Response.json(
        { error: 'Invalid remediation callback payload', issues: parsedPayload.error.issues },
        { status: 400 }
      );
    }

    await env.REMEDIATION_CALLBACK_QUEUE.sendBatch([
      {
        body: { attemptId, attemptToken, payload: parsedPayload.data },
        contentType: 'json',
      },
    ]);
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
    const dispatchId = randomUUID();
    try {
      await dispatchDueOwners(env, dispatchId);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      ctx.waitUntil(
        sendBetterStackHeartbeat({
          heartbeatUrl: env.BETTERSTACK_HEARTBEAT_URL,
          dispatcherFailed: failed,
          dispatchId,
          env,
        })
      );
    }
  },

  async queue(batch: MessageBatch<unknown>, env: CloudflareEnv): Promise<void> {
    if (batch.queue.startsWith('security-remediation-attempt-queue')) {
      await consumeRemediationAttemptBatch(batch, env);
      return;
    }
    if (batch.queue.startsWith('security-remediation-command-queue')) {
      await consumeApplyAutoRemediationBatch(batch, env);
      return;
    }
    if (batch.queue.startsWith('security-remediation-callback-queue')) {
      await consumeRemediationCallbackBatch(batch, env);
      return;
    }
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
