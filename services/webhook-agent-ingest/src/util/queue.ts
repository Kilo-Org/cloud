import { logger } from './logger';
import { z } from 'zod';

export const WebhookDeliveryMessageSchema = z.object({
  namespace: z.string().min(1),
  triggerId: z.string().min(1),
  requestId: z.string().min(1),
  githubIntegrationId: z.string().uuid().optional(),
});

export type WebhookDeliveryMessage = z.infer<typeof WebhookDeliveryMessageSchema>;

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
