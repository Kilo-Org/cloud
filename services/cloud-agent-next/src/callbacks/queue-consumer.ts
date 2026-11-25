import type { CallbackQueueJob } from './types.js';
import { deliverCallbackJob } from './delivery.js';
import { logger } from '../logger.js';
import {
  PARENT_WORKSPACE_CALLBACK_URL,
  parseWorkspaceSessionCallbackTarget,
} from '@kilocode/worker-utils/cloud-agent-authority';
import type { Env } from '../types.js';
import { deliverWorkspaceSessionCallback } from './parent-session.js';
import { deliverParentWorkspaceCallback } from './parent-workspace.js';

export function createCallbackQueueConsumer(env: Env) {
  return async function callbackQueueConsumer(
    batch: MessageBatch<CallbackQueueJob>
  ): Promise<void> {
    for (const message of batch.messages) {
      await processMessage(message, env);
    }
  };
}

async function processMessage(message: Message<CallbackQueueJob>, env: Env): Promise<void> {
  const job = message.body;
  const interaction = 'type' in job;
  const identity = interaction
    ? { cloudAgentSessionId: job.payload.cloudAgentSessionId, questionId: job.payload.question.id }
    : {
        sessionId: job.payload.sessionId,
        cloudAgentSessionId: job.payload.cloudAgentSessionId,
        messageId: job.payload.messageId,
      };

  const result =
    job.target.url === PARENT_WORKSPACE_CALLBACK_URL
      ? await deliverParentWorkspaceCallback(env, job, message.attempts)
      : parseWorkspaceSessionCallbackTarget(job.target.url) !== null
        ? await deliverWorkspaceSessionCallback(env, job, message.attempts)
        : interaction
          ? { type: 'failed' as const, error: 'Invalid question callback target' }
          : await deliverCallbackJob(job.target, job.payload, message.attempts);

  switch (result.type) {
    case 'success':
      message.ack();
      break;

    case 'retry':
      message.retry({ delaySeconds: result.delaySeconds });
      logger
        .withFields({
          ...identity,
          attempts: message.attempts,
          delaySeconds: result.delaySeconds,
        })
        .warn('Callback queue message scheduled for retry');
      break;

    case 'failed':
      // TODO: Send to DLQ when implemented
      logger
        .withFields({
          ...identity,
          attempts: message.attempts,
        })
        .error(`Callback delivery failed permanently: ${result.error}`);
      message.ack();
      break;
  }
}
