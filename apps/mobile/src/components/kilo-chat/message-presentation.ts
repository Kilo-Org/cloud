import {
  type AttachmentBlock,
  contentBlocksPreviewText,
  contentBlocksToText,
  type ConversationDetailResponse,
  type CreateMessageRequest,
  type InputContentBlock,
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
  content: InputContentBlock[];
  clientId: string;
  inReplyToMessageId?: string;
};

export function buildSendMessageVariables(
  input: BuildSendMessageVariablesInput
): SendMessageVariables {
  return {
    conversationId: input.conversationId,
    content: input.content,
    clientId: input.clientId,
    ...(input.inReplyToMessageId ? { inReplyToMessageId: input.inReplyToMessageId } : {}),
  };
}

export function getEditableAttachmentBlocks(message: Message): AttachmentBlock[] {
  return message.content.filter((block): block is AttachmentBlock => block.type === 'attachment');
}

export function getVisibleEditableAttachmentBlocks(
  attachments: readonly AttachmentBlock[],
  removedAttachmentIds: readonly string[]
): AttachmentBlock[] {
  const removedAttachmentIdSet = new Set(removedAttachmentIds);
  return attachments.filter(attachment => !removedAttachmentIdSet.has(attachment.attachmentId));
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

export function getReplyPreviewText(replyToMessage: ReplyPreviewSource): string {
  if (replyToMessage.deleted) {
    return '[deleted message]';
  }
  if ('previewText' in replyToMessage) {
    return replyToMessage.previewText ?? 'Message';
  }
  return contentBlocksPreviewText(replyToMessage.content) || 'Message';
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
  return !message.deleted && contentBlocksToText(message.content).trim().length > 0;
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
