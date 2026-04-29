import type {
  chatWebhookRpcSchema,
  ContentBlock,
  messageCreatedWebhookSchema,
  actionExecutedWebhookSchema,
} from '@kilocode/kilo-chat';
import { formatError, withDORetry } from '@kilocode/worker-utils';
import type { z } from 'zod';
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
  const text = msg.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
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
    } satisfies z.infer<typeof chatWebhookRpcSchema>;

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
      await notifyMessageDeliveryFailed(env, {
        conversationId: msg.conversationId,
        messageId: msg.messageId,
        convContext,
      });
    } catch (err) {
      logger.error('Failed to notify delivery failure', formatError(err));
    }
  });
}

/**
 * Flip the `delivery_failed` flag on a message and push the
 * `message.delivery_failed` event to human members. One source of truth for
 * both the RPC-exhausted retry path and the bot-reported failure route.
 */
export async function notifyMessageDeliveryFailed(
  env: Env,
  params: {
    conversationId: string;
    messageId: string;
    convContext?: { humanMemberIds: string[]; sandboxId: string | null };
  }
): Promise<void> {
  await withDORetry(
    () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(params.conversationId)),
    stub => stub.notifyDeliveryFailed(params.messageId),
    'ConversationDO.notifyDeliveryFailed'
  );

  const ctx = params.convContext ?? (await getConversationContext(env, params.conversationId));
  if (ctx?.sandboxId) {
    await pushEventToHumanMembers(
      env,
      params.conversationId,
      ctx.sandboxId,
      ctx.humanMemberIds,
      'message.delivery_failed',
      { messageId: params.messageId }
    );
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
  return withLogTags({ source: 'deliverActionExecutedToBot' }, async () => {
    logger.setTags({
      targetBotId: msg.targetBotId,
      conversationId: msg.conversationId,
      messageId: msg.messageId,
    });

    // Payload fields are already validated; skip redundant Zod parse.
    const rpcPayload = msg satisfies z.infer<typeof chatWebhookRpcSchema>;
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
