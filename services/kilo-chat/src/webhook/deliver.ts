import { getConversationContext, pushEventToHumanMembers } from '../services/event-push';

type KiloclawBinding = Fetcher & {
  deliverChatWebhook(payload: WebhookPayload & { targetBotId: string }): Promise<void>;
};

export type WebhookMessage = {
  targetBotId: string;
  conversationId: string;
  messageId: string;
  from: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  sentAt: string;
  inReplyToMessageId?: string;
  inReplyToBody?: string;
  inReplyToSender?: string;
};

type WebhookPayload = {
  conversationId: string;
  messageId: string;
  from: string;
  text: string;
  sentAt: string;
  inReplyToMessageId?: string;
  inReplyToBody?: string;
  inReplyToSender?: string;
};

type ConversationStub = {
  notifyDeliveryFailed(messageId: string, senderId: string): Promise<void>;
};

function buildPayload(msg: WebhookMessage): WebhookPayload {
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
    ...(msg.inReplyToMessageId !== undefined && { inReplyToMessageId: msg.inReplyToMessageId }),
    ...(msg.inReplyToBody !== undefined && { inReplyToBody: msg.inReplyToBody }),
    ...(msg.inReplyToSender !== undefined && { inReplyToSender: msg.inReplyToSender }),
  };
}

const MAX_RETRIES = 2;

/**
 * Delivers a webhook to a bot via direct RPC to kiloclaw.
 * Retries up to 2 times, then notifies the conversation of permanent failure.
 */
export async function deliverToBot(
  env: Env,
  convStub: ConversationStub,
  msg: WebhookMessage
): Promise<void> {
  const payload = buildPayload(msg);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await (env.KILOCLAW as KiloclawBinding).deliverChatWebhook({
        targetBotId: msg.targetBotId,
        ...payload,
      });
      return;
    } catch (err) {
      console.error(`Webhook delivery attempt ${attempt + 1} failed:`, err);
    }
  }

  console.error(
    `Webhook permanently failed for message ${msg.messageId} in conversation ${msg.conversationId}`
  );
  try {
    await convStub.notifyDeliveryFailed(msg.messageId, msg.from);

    // Push delivery_failed event to human members
    const convContext = await getConversationContext(env, msg.conversationId);
    if (convContext?.sandboxId) {
      await pushEventToHumanMembers(
        env,
        msg.conversationId,
        convContext.sandboxId,
        convContext.humanMemberIds,
        'message.delivery_failed',
        { messageId: msg.messageId }
      );
    }
  } catch (err) {
    console.error('Failed to notify delivery failure:', err);
  }
}
