import {
  chatWebhookRpcSchema,
  contentBlockSchema,
  type messageCreatedWebhookSchema,
  type actionExecutedWebhookSchema,
} from '@kilocode/kilo-chat';
import { z } from 'zod';
import { getConversationContext, pushEventToHumanMembers } from '../services/event-push';

type MessageCreatedPayload = z.infer<typeof messageCreatedWebhookSchema>;
type ActionExecutedWebhookPayload = z.infer<typeof actionExecutedWebhookSchema>;

export type WebhookMessage = {
  targetBotId: string;
  conversationId: string;
  messageId: string;
  from: string;
  content: unknown;
  sentAt: string;
  inReplyToMessageId?: string;
  inReplyToBody?: string;
  inReplyToSender?: string;
};

type ConversationStub = {
  notifyDeliveryFailed(messageId: string, senderId: string): Promise<void>;
};

const webhookContentSchema = z.array(contentBlockSchema).catch([]);

function buildPayload(msg: WebhookMessage): MessageCreatedPayload {
  const blocks = webhookContentSchema.parse(msg.content);
  const text = blocks
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  return {
    type: 'message.created',
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
  msg: WebhookMessage,
  convContext?: { humanMemberIds: string[]; sandboxId: string | null }
): Promise<void> {
  const payload = buildPayload(msg);
  const rpcPayload = chatWebhookRpcSchema.parse({
    targetBotId: msg.targetBotId,
    ...payload,
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await env.KILOCLAW.deliverChatWebhook(rpcPayload);
      return;
    } catch (err) {
      console.error(`Webhook delivery attempt ${attempt + 1} failed:`, err);
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }

  console.error(
    `Webhook permanently failed for message ${msg.messageId} in conversation ${msg.conversationId}`
  );
  try {
    await convStub.notifyDeliveryFailed(msg.messageId, msg.from);

    // Push delivery_failed event to human members
    const ctx = convContext ?? (await getConversationContext(env, msg.conversationId));
    if (ctx?.sandboxId) {
      await pushEventToHumanMembers(
        env,
        msg.conversationId,
        ctx.sandboxId,
        ctx.humanMemberIds,
        'message.delivery_failed',
        { messageId: msg.messageId }
      );
    }
  } catch (err) {
    console.error('Failed to notify delivery failure:', err);
  }
}

/**
 * Delivers an action.executed webhook to a bot via direct RPC to kiloclaw.
 * Retries up to 2 times, then logs permanent failure.
 */
export async function deliverActionExecutedToBot(
  env: Env,
  msg: ActionExecutedWebhookPayload & { targetBotId: string }
): Promise<void> {
  const rpcPayload = chatWebhookRpcSchema.parse(msg);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await env.KILOCLAW.deliverChatWebhook(rpcPayload);
      return;
    } catch (err) {
      console.error(`Action webhook delivery attempt ${attempt + 1} failed:`, err);
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }
  console.error(`Action webhook permanently failed for message ${msg.messageId}`);
}
