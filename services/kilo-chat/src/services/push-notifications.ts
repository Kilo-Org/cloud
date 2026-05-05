import type { ContentBlock } from '@kilocode/kilo-chat';
import type { SendPushForConversationInput } from '@kilocode/notifications';
import { formatError } from '@kilocode/worker-utils';

import { contentBlocksToText } from '../util/content';
import { logger } from '../util/logger';
import { fetchSandboxLabel } from './sandbox-lookup';

export const BOT_MESSAGE_NOTIFICATION_MIN_TEXT_CHARS = 160;
export const BOT_MESSAGE_NOTIFICATION_TIMEOUT_MS = 10_000;

export type ConversationPushRecipientMode = 'exclude-sender-human' | 'all-human-members';

export type ConversationMessagePushInput = {
  conversationId: string;
  sandboxId: string;
  title: string | null;
  humanMemberIds: string[];
  senderId: string;
  senderIsHuman: boolean;
  messageId: string;
  content: ContentBlock[];
  recipientMode: ConversationPushRecipientMode;
  logContext: 'message.created' | 'bot.length' | 'bot.typing_stop' | 'bot.timeout';
};

function recipientsFor(input: ConversationMessagePushInput): string[] {
  if (input.recipientMode === 'all-human-members') {
    return input.humanMemberIds;
  }

  return input.humanMemberIds.filter(id => id !== input.senderId);
}

export function botMessageNotificationTextLength(content: ContentBlock[]): number {
  return contentBlocksToText(content).trim().length;
}

export async function sendConversationMessagePush(
  env: Env,
  input: ConversationMessagePushInput
): Promise<void> {
  if (input.sandboxId.length === 0) return;

  const recipientUserIds = recipientsFor(input);
  if (recipientUserIds.length === 0) return;

  try {
    const bodyPreview = contentBlocksToText(input.content).slice(0, 200);
    const sandboxLabel = await fetchSandboxLabel(env.HYPERDRIVE.connectionString, input.sandboxId);
    const conversationTitle = input.title ?? 'Untitled';
    const payload = {
      conversationId: input.conversationId,
      sandboxId: input.sandboxId,
      senderUserId: input.senderIsHuman ? input.senderId : null,
      recipientUserIds,
      title: `${sandboxLabel} · ${conversationTitle}`,
      bodyPreview,
      messageId: input.messageId,
    } satisfies SendPushForConversationInput;

    const pushResult = await env.NOTIFICATIONS.sendPushForConversation(payload);
    const failedRecipients = pushResult.perRecipient.filter(result => result.outcome === 'failed');
    if (failedRecipients.length > 0) {
      logger.error('sendPushForConversation returned failed outcomes', {
        conversationId: input.conversationId,
        sandboxId: input.sandboxId,
        messageId: input.messageId,
        trigger: input.logContext,
        failedRecipients,
      });
    }
  } catch (err) {
    logger.error('sendPushForConversation failed', {
      trigger: input.logContext,
      ...formatError(err),
    });
  }
}
