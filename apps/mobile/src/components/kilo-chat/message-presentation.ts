import {
  type CreateMessageRequest,
  type Message,
  type ReplyToMessageSnapshot,
} from '@kilocode/kilo-chat';
import { ulid } from 'ulid';

export type SendMessageVariables = CreateMessageRequest & { clientId: string };
export type ReplyPreviewSource = Message | ReplyToMessageSnapshot;

type BuildSendMessageVariablesInput = {
  conversationId: string;
  text: string;
  clientId: string;
  inReplyToMessageId?: string;
};

export function buildSendMessageVariables({
  conversationId,
  text,
  clientId,
  inReplyToMessageId,
}: BuildSendMessageVariablesInput): SendMessageVariables {
  const content: CreateMessageRequest['content'] = [{ type: 'text', text }];
  return {
    conversationId,
    content,
    clientId,
    ...(inReplyToMessageId ? { inReplyToMessageId } : {}),
  };
}

export function createSendMessageClientId(): string {
  return ulid();
}

export function contentBlocksToPreviewText(content: Message['content']): string {
  const preview = content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
  return preview || 'Message';
}

export function getReplyPreviewText(replyToMessage: ReplyPreviewSource): string {
  if (replyToMessage.deleted) {
    return '[deleted message]';
  }
  if ('previewText' in replyToMessage) {
    return replyToMessage.previewText ?? 'Message';
  }
  return contentBlocksToPreviewText(replyToMessage.content);
}

export function getDeliveryFailureLabel(message: Message): string | null {
  return message.deliveryFailed ? 'Not delivered' : null;
}

export function canShowReactionPills(message: Message): boolean {
  return !message.deleted && message.reactions.length > 0;
}

export function canToggleReaction(message: Message, currentUserId: string | null): boolean {
  return currentUserId !== null && !message.deleted && !message.deliveryFailed;
}
