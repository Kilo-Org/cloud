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
import type {
  ConversationDO,
  NotifyDeliveryFailedResult,
  RevertActionResolutionResult,
} from '../do/conversation-do';

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

type ConversationEventContext = { humanMemberIds: string[]; sandboxId: string | null };

export type ActionExecutedWebhookMessage = ActionExecutedWebhookPayload & {
  targetBotId: string;
  convContext?: ConversationEventContext;
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
    if (payload.text.length === 0) return;

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
    convContext?: ConversationEventContext;
  }
): Promise<NotifyDeliveryFailedResult> {
  const result = await withDORetry<DurableObjectStub<ConversationDO>, NotifyDeliveryFailedResult>(
    () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(params.conversationId)),
    async stub => {
      const result: NotifyDeliveryFailedResult = await stub.notifyDeliveryFailed(params.messageId);
      return result;
    },
    'ConversationDO.notifyDeliveryFailed'
  );
  if (!result.ok) {
    return result;
  }
  if (!result.changed) {
    return result;
  }

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
  return result;
}

/**
 * Roll back an optimistically resolved action group and push
 * `action.delivery_failed` to human members. Used when the direct
 * action.executed RPC cannot be delivered to the bot after retries.
 */
export async function notifyActionDeliveryFailed(
  env: Env,
  params: {
    conversationId: string;
    messageId: string;
    groupId: string;
    convContext?: ConversationEventContext;
  }
): Promise<void> {
  const result = await withDORetry<DurableObjectStub<ConversationDO>, RevertActionResolutionResult>(
    () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(params.conversationId)),
    async stub => {
      const result: RevertActionResolutionResult = await stub.revertActionResolution({
        messageId: params.messageId,
        groupId: params.groupId,
      });
      return result;
    },
    'ConversationDO.revertActionResolution'
  );
  if (!result.ok) {
    return;
  }
  if (!result.reverted) {
    return;
  }

  const ctx = params.convContext ?? (await getConversationContext(env, params.conversationId));
  if (ctx?.sandboxId) {
    await pushEventToHumanMembers(
      env,
      params.conversationId,
      ctx.sandboxId,
      ctx.humanMemberIds,
      'action.delivery_failed',
      {
        conversationId: params.conversationId,
        messageId: params.messageId,
        groupId: params.groupId,
      }
    );
  }
}

/**
 * Delivers an action.executed webhook to a bot via direct RPC to kiloclaw.
 * Retries up to 2 times, then logs permanent failure.
 */
export async function deliverActionExecutedToBot(
  env: Env,
  msg: ActionExecutedWebhookMessage
): Promise<void> {
  return withLogTags({ source: 'deliverActionExecutedToBot' }, async () => {
    logger.setTags({
      targetBotId: msg.targetBotId,
      conversationId: msg.conversationId,
      messageId: msg.messageId,
    });

    // Payload fields are already validated; skip redundant Zod parse.
    const rpcPayload = {
      type: msg.type,
      targetBotId: msg.targetBotId,
      conversationId: msg.conversationId,
      messageId: msg.messageId,
      groupId: msg.groupId,
      value: msg.value,
      executedBy: msg.executedBy,
      executedAt: msg.executedAt,
    } satisfies z.infer<typeof chatWebhookRpcSchema>;
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
    try {
      await notifyActionDeliveryFailed(env, {
        conversationId: msg.conversationId,
        messageId: msg.messageId,
        groupId: msg.groupId,
        convContext: msg.convContext,
      });
    } catch (err) {
      logger.error('Failed to notify action delivery failure', formatError(err));
    }
  });
}
