import type { CallbackJob } from './types.js';
import { deliverCallbackJob } from './delivery.js';

export function createCallbackQueueConsumer() {
  return async function callbackQueueConsumer(batch: MessageBatch<CallbackJob>): Promise<void> {
    for (const message of batch.messages) {
      await processMessage(message);
    }
  };
}

async function processMessage(message: Message<CallbackJob>): Promise<void> {
  const job = message.body;

  const result = await deliverCallbackJob(job.target, job.payload, message.attempts);

  switch (result.type) {
    case 'success':
      message.ack();
      break;

    case 'retry':
      message.retry({ delaySeconds: result.delaySeconds });
      break;

    case 'failed':
      // TODO: Send to DLQ when implemented
      console.error(`Callback delivery failed: ${result.error}`, {
        sessionId: job.payload.sessionId,
        executionId: job.payload.executionId,
        attempts: message.attempts,
      });
      message.ack();
      break;
  }
}
