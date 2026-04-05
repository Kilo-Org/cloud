import { logger } from './logger';

export type WebhookDeliveryMessage = {
  namespace: string;
  triggerId: string;
  requestId: string;
};

export async function enqueueWebhookDelivery(
  queue: Queue<WebhookDeliveryMessage>,
  message: WebhookDeliveryMessage
): Promise<void> {
  await queue.send(message, { contentType: 'json' });

  logger.info('Webhook delivery message enqueued', {
    namespace: message.namespace,
    triggerId: message.triggerId,
    requestId: message.requestId,
  });
}
