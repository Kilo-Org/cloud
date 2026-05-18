import type { CallbackJob } from './types.js';
import { deliverCallbackJob } from './delivery.js';
import { logger } from '../logger.js';
import type { Env } from '../types.js';

export function createCallbackQueueConsumer(env: Pick<Env, 'SECURITY_AUTO_ANALYSIS'>) {
  return async function callbackQueueConsumer(batch: MessageBatch<CallbackJob>): Promise<void> {
    for (const message of batch.messages) {
      await processMessage(message, env);
    }
  };
}

async function processMessage(
  message: Message<CallbackJob>,
  env: Pick<Env, 'SECURITY_AUTO_ANALYSIS'>
): Promise<void> {
  const job = message.body;

  const result = await deliverCallbackJob(job.target, job.payload, message.attempts, {
    securityAutoAnalysis: env.SECURITY_AUTO_ANALYSIS,
  });

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
