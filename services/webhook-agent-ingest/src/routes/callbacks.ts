import { Hono } from 'hono';
import { z } from 'zod';
import type { HonoContext } from '../index';
import { internalApiMiddleware } from '../util/auth';
import { logger } from '../util/logger';
import { resError, resSuccess } from '@kilocode/worker-utils';
import { withDORetry } from '../util/do-retry';

const callbacks = new Hono<HonoContext>();

const ExecutionCallbackPayloadSchema = z.object({
  sessionId: z.string(),
  cloudAgentSessionId: z.string(),
  executionId: z.string(),
  status: z.enum(['completed', 'failed', 'interrupted']),
  errorMessage: z.string().optional(),
  lastSeenBranch: z.string().optional(),
  kiloSessionId: z.string().optional(),
});

callbacks.use('*', internalApiMiddleware);

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
        error_message: payload.errorMessage,
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
