import { Hono } from 'hono';
import { z } from 'zod';
import type { HonoContext } from '../index';
import { logger } from '../util/logger';
import { resError, resSuccess, verifyCallbackToken } from '@kilocode/worker-utils';
import { INTERNAL_CALLER_HEADER } from '@kilocode/worker-utils/internal-auth-observation';
import { CloudAgentCallbackFailureSchema } from '@kilocode/worker-utils/cloud-agent-failure';
import { withDORetry } from '../util/do-retry';
import { expectedSecret, secretUnavailableResponse } from '../secrets';
import { secretsComparison, type CheckedSecret } from '../secrets-compare';

const callbacks = new Hono<HonoContext>();

const ExecutionCallbackPayloadSchema = z.object({
  sessionId: z.string(),
  cloudAgentSessionId: z.string(),
  executionId: z.string(),
  status: z.enum(['completed', 'failed', 'interrupted']),
  errorMessage: z.string().optional(),
  failure: CloudAgentCallbackFailureSchema,
  lastSeenBranch: z.string().optional(),
  kiloSessionId: z.string().optional(),
});

callbacks.post('/execution', async c => {
  const namespace = c.req.header('x-webhook-namespace');
  const triggerId = c.req.header('x-webhook-trigger-id');
  const requestId = c.req.header('x-webhook-request-id');

  if (!namespace || !triggerId || !requestId) {
    logger.warn('Callback missing required webhook headers', {
      hasNamespace: !!namespace,
      hasTriggerId: !!triggerId,
      hasRequestId: !!requestId,
    });
    return c.json(resError('Missing webhook identification headers'), 400);
  }

  const callbackToken = c.req.header('X-Callback-Token');
  const expected = await expectedSecret(c.env, 'CALLBACK_TOKEN_SECRET', callbackToken);
  if (expected.status === 'refused') {
    return secretUnavailableResponse('execution-callback', expected.reason);
  }
  if (expected.status === 'read' && !expected.secret) {
    logger.error('Callback authentication secret not configured');
    return c.json(resError('Internal server error'), 500);
  }

  // A tokenless request under `sts` read no secret and is refused here without a check.
  const validCallbackToken =
    expected.status === 'read' &&
    (await verifyCallbackToken({
      token: callbackToken,
      secret: expected.secret,
      scope: 'webhook-execution-callback',
      resourceParts: [namespace, triggerId, requestId],
      observation: {
        receiver: 'webhook-agent-ingest',
        caller: c.req.header(INTERNAL_CALLER_HEADER) ?? null,
      },
    }));
  const checked: CheckedSecret = {
    route: 'execution-callback',
    source: expected.source,
    selected: expected.status === 'read' ? expected.secret : '',
  };
  if (!validCallbackToken) {
    logger.warn('Callback authentication failed', {
      route: checked.route,
      secret: 'CALLBACK_TOKEN_SECRET',
      source: checked.source,
      reason: callbackToken ? 'invalid' : 'missing',
    });
    // A refused token starts at most one background check of this name per isolate when enabled
    // (src/secrets-compare.ts); a tokenless request starts none. Neither changes this answer.
    if (callbackToken) secretsComparison.refused(c.env, () => c.executionCtx, checked);
    return c.json(resError('Unauthorized'), 401);
  }
  // Background source comparison, off unless enabled (src/secrets-compare.ts). It never changes
  // this answer.
  secretsComparison.admitted(c.env, () => c.executionCtx, checked);

  let payload: z.infer<typeof ExecutionCallbackPayloadSchema>;
  try {
    payload = ExecutionCallbackPayloadSchema.parse(await c.req.json());
  } catch (error) {
    logger.warn('Invalid callback payload', { error });
    return c.json(resError('Invalid callback payload'), 400);
  }

  const doKey = `${namespace}/${triggerId}`;
  const doId = c.env.TRIGGER_DO.idFromName(doKey);
  const stub = c.env.TRIGGER_DO.get(doId);

  const request = await withDORetry(
    () => stub,
    doStub => doStub.getRequest(requestId),
    'getRequest'
  );

  if (!request) {
    logger.warn('Callback for non-existent request', { requestId, namespace, triggerId });
    return c.json(resError('Request not found'), 404);
  }

  if (request.processStatus !== 'inprogress') {
    logger.warn('Callback for request not in progress', {
      requestId,
      currentStatus: request.processStatus,
    });
    return c.json(resSuccess({ message: 'Request already completed' }));
  }

  if (request.cloudAgentSessionId !== payload.cloudAgentSessionId) {
    logger.warn('Callback cloudAgentSessionId mismatch', {
      requestId,
      expectedSessionId: request.cloudAgentSessionId,
      receivedSessionId: payload.cloudAgentSessionId,
    });
    return c.json(resError('Session ID mismatch'), 403);
  }

  await withDORetry(
    () => stub,
    doStub =>
      doStub.updateRequest(requestId, {
        process_status: payload.status === 'completed' ? 'success' : 'failed',
        completed_at: new Date().toISOString(),
        error_message: payload.failure?.message ?? payload.errorMessage,
      }),
    'updateRequest'
  );

  logger.info('Callback processed successfully', {
    requestId,
    status: payload.status,
  });

  return c.json(resSuccess({ success: true }));
});

export { callbacks };
