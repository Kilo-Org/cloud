export type WebhookMessage = {
  targetBotId: string;
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
