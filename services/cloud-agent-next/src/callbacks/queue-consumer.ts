import type { CallbackJob } from './types.js';
import { deliverCallbackJob } from './delivery.js';
import { logger } from '../logger.js';
import { PARENT_SESSION_CALLBACK_URL } from '@kilocode/worker-utils/cloud-agent-authority';
import type { Env } from '../types.js';
import { deliverParentSessionCallback } from './parent-session.js';

export function createCallbackQueueConsumer(env: Env) {
  return async function callbackQueueConsumer(batch: MessageBatch<CallbackJob>): Promise<void> {
    for (const message of batch.messages) {
      await processMessage(message, env);
    }
  };
}

async function processMessage(message: Message<CallbackJob>, env: Env): Promise<void> {
  const job = message.body;

  const result =
    job.target.url === PARENT_SESSION_CALLBACK_URL
      ? await deliverParentSessionCallback(env, job, message.attempts)
      : await deliverCallbackJob(job.target, job.payload, message.attempts);

  switch (result.type) {
    case 'success':
      message.ack();
      break;

    case 'retry':
      message.retry({ delaySeconds: result.delaySeconds });
      logger
        .withFields({
          sessionId: job.payload.sessionId,
          cloudAgentSessionId: job.payload.cloudAgentSessionId,
          messageId: job.payload.messageId,
          attempts: message.attempts,
          delaySeconds: result.delaySeconds,
        })
        .warn('Callback queue message scheduled for retry');
      break;

    case 'failed':
      // TODO: Send to DLQ when implemented
      logger
        .withFields({
          sessionId: job.payload.sessionId,
          cloudAgentSessionId: job.payload.cloudAgentSessionId,
          messageId: job.payload.messageId,
          attempts: message.attempts,
        })
        .error(`Callback delivery failed permanently: ${result.error}`);
      message.ack();
      break;
  }
}
