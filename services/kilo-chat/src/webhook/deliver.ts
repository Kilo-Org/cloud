import { createHmac } from 'node:crypto';

export type WebhookMessage = {
  conversationId: string;
  messageId: string;
  from: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  sentAt: string;
};

export type WebhookPayload = {
  conversationId: string;
  messageId: string;
  from: string;
  text: string;
  sentAt: string;
};

export function buildWebhookPayload(msg: WebhookMessage): WebhookPayload {
  const text = msg.content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('');
  return {
    conversationId: msg.conversationId,
    messageId: msg.messageId,
    from: msg.from,
    text,
    sentAt: msg.sentAt,
  };
}

export function signPayload(body: string, secret: string): string {
  const hex = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hex}`;
}

export async function deliverWebhook(
  msg: WebhookMessage,
  webhookUrl: string,
  webhookSecret: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const payload = buildWebhookPayload(msg);
  const body = JSON.stringify(payload);
  const signature = signPayload(body, webhookSecret);

  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kilo-chat-signature': signature,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Webhook delivery failed: ${response.status} ${await response.text()}`);
  }
}
