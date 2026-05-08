import {
  type ConversationDetailResponse,
  type CreateMessageRequest,
  type Message,
  type ReplyToMessageSnapshot,
} from '@kilocode/kilo-chat';
import * as Crypto from 'expo-crypto';
import { ulid } from 'ulid';

type SendMessageVariables = CreateMessageRequest & { clientId: string };
export type ReplyPreviewSource = Message | ReplyToMessageSnapshot;
export type MessageAuthorMember = ConversationDetailResponse['members'][number];

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
  return ulid(undefined, expoCryptoPrng);
}

function expoCryptoPrng(): number {
  const bytes = Crypto.getRandomValues(new Uint8Array(1));
  const byte = bytes[0];
  if (byte === undefined) {
    throw new Error('Failed to generate a random byte');
  }
  return byte / 255;
}

function contentBlocksToPreviewText(content: Message['content']): string {
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

export function isMessageTextSelectionEnabled(): boolean {
  return false;
}

export function canShowReactionPills(message: Message): boolean {
  return !message.deleted && message.reactions.length > 0;
}

export function canToggleReaction(message: Message, currentUserId: string | null): boolean {
  return currentUserId !== null && !message.deleted && !message.deliveryFailed;
}

export function canCopyMessage(message: Message): boolean {
  return !message.deleted && contentBlocksToPreviewText(message.content).trim().length > 0;
}

export function isMessageEdited(message: Message): boolean {
  return !message.deleted && message.clientUpdatedAt !== null;
}

function firstDisplayValue(values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

export function resolveMessageAuthorLabel({
  senderId,
  members = [],
  botName,
}: {
  senderId: string;
  members?: readonly MessageAuthorMember[];
  botName?: string | null;
}): string {
  const member = members.find(candidate => candidate.id === senderId);
  if (senderId.startsWith('bot:')) {
    return firstDisplayValue([botName, member?.displayName]) ?? 'KiloClaw';
  }
  return firstDisplayValue([member?.displayName]) ?? senderId;
}
