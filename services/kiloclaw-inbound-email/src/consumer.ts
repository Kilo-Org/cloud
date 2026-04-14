import type { AppEnv, InboundEmailQueueMessage } from './types';

const PERMANENT_DELIVERY_STATUSES = new Set([400, 404, 410, 422]);

export async function deliverInboundEmail(
  message: InboundEmailQueueMessage,
  env: AppEnv
): Promise<void> {
  const internalApiSecret = await env.INTERNAL_API_SECRET.get();
  const response = await env.KILOCLAW.fetch(
    new Request('https://kiloclaw/api/platform/inbound-email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': internalApiSecret,
      },
      body: JSON.stringify(message),
    })
  );

  if (response.ok) return;

  if (PERMANENT_DELIVERY_STATUSES.has(response.status)) {
    console.warn(
      JSON.stringify({
        message: 'inbound email permanently rejected',
        instanceId: message.instanceId,
        messageId: message.messageId,
        from: message.from,
        to: message.to,
        status: response.status,
      })
    );
    return;
  }

  throw new Error(`Inbound email delivery failed with status ${response.status}`);
}

export async function handleQueue(
  batch: MessageBatch<InboundEmailQueueMessage>,
  env: AppEnv
): Promise<void> {
  for (const message of batch.messages) {
    await deliverInboundEmail(message.body, env);
  }
}
