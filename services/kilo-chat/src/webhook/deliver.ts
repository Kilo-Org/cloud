import {
  chatWebhookRpcSchema,
  type ContentBlock,
  type messageCreatedWebhookSchema,
  type actionExecutedWebhookSchema,
} from '@kilocode/kilo-chat';
import { formatError, withDORetry } from '@kilocode/worker-utils';
import { z } from 'zod';
import { logger, withLogTags } from '../util/logger';
import { getConversationContext, pushEventToHumanMembers } from '../services/event-push';

type MessageCreatedPayload = z.infer<typeof messageCreatedWebhookSchema>;
type ActionExecutedWebhookPayload = z.infer<typeof actionExecutedWebhookSchema>;

export type WebhookMessage = {
  targetBotId: string;
  conversationId: string;
  messageId: string;
  from: string;
  content: ContentBlock[];
  sentAt: string;
  inReplyToMessageId?: string;
  inReplyToBody?: string;
  inReplyToSender?: string;
};

function buildPayload(msg: WebhookMessage): MessageCreatedPayload {
  // Content was validated at the route handler entry point; trust the shape.
  const blocks = msg.content as ContentBlock[];
  const text = blocks
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
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
  msg: WebhookMessage,
  convContext?: { humanMemberIds: string[]; sandboxId: string | null }
): Promise<void> {
  return withLogTags({ source: 'deliverToBot' }, async () => {
    logger.setTags({
      targetBotId: msg.targetBotId,
      conversationId: msg.conversationId,
      messageId: msg.messageId,
    });

    const payload = buildPayload(msg);
    // Payload fields are already validated; skip redundant Zod parse.
    const rpcPayload = {
      targetBotId: msg.targetBotId,
      ...payload,
    } as z.infer<typeof chatWebhookRpcSchema>;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await env.KILOCLAW.deliverChatWebhook(rpcPayload);
        return;
      } catch (err) {
        logger.error('Webhook delivery failed', { attempt: attempt + 1, ...formatError(err) });
        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        }
      }
    }

    logger.error('Webhook permanently failed');
    try {
      await withDORetry(
        () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(msg.conversationId)),
        stub => stub.notifyDeliveryFailed(msg.messageId, msg.from),
        'ConversationDO.notifyDeliveryFailed'
      );

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
      logger.error('Failed to notify delivery failure', formatError(err));
    }
  });
}

/**
 * Delivers an action.executed webhook to a bot via direct RPC to kiloclaw.
 * Retries up to 2 times, then logs permanent failure.
 */
export async function deliverActionExecutedToBot(
  env: Env,
  msg: ActionExecutedWebhookPayload & { targetBotId: string }
): Promise<void> {
  return withLogTags({ source: 'deliverActionExecutedToBot' }, async () => {
    logger.setTags({
      targetBotId: msg.targetBotId,
      conversationId: msg.conversationId,
      messageId: msg.messageId,
    });

    // Payload fields are already validated; skip redundant Zod parse.
    const rpcPayload = msg as z.infer<typeof chatWebhookRpcSchema>;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await env.KILOCLAW.deliverChatWebhook(rpcPayload);
        return;
      } catch (err) {
        logger.error('Action webhook delivery failed', {
          attempt: attempt + 1,
          ...formatError(err),
        });
        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        }
      }
    }
    logger.error('Action webhook permanently failed');
  });
}
