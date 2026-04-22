import { z } from 'zod';

const nonEmptyString = z.string().min(1);

// Reusable param fragments
export const conversationTargetParams = z
  .object({
    to: nonEmptyString.optional(),
    // The message tool agent may pass the conversation ID as threadId.
    threadId: nonEmptyString.optional(),
  })
  .passthrough();

export const messageTargetParams = conversationTargetParams.extend({
  messageId: nonEmptyString.optional(),
});

export const paginationParams = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
    before: nonEmptyString.optional(),
  })
  .passthrough();

// Per-action schemas
export const readActionParams = conversationTargetParams.extend({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  before: nonEmptyString.optional(),
});

export const reactActionParams = messageTargetParams.extend({
  emoji: z.string().optional(),
  remove: z.boolean().optional(),
});

export const renameActionParams = conversationTargetParams.extend({
  title: nonEmptyString.optional(),
  // The message tool agent may use these aliases instead of `title`.
  threadName: nonEmptyString.optional(),
  name: nonEmptyString.optional(),
  text: nonEmptyString.optional(),
});

export const editActionParams = messageTargetParams.extend({
  text: nonEmptyString.optional(),
});

export const deleteActionParams = messageTargetParams;

export const memberInfoActionParams = conversationTargetParams;

export const listConversationsActionParams = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .passthrough();

export const createConversationActionParams = z
  .object({
    title: nonEmptyString.optional(),
    members: nonEmptyString.optional(),
  })
  .passthrough();

export function stripPrefix(raw: string): string {
  return raw.trim().replace(/^kilo-chat:/i, '');
}

export function resolveConversationId(
  parsed: { to?: string; threadId?: string },
  toolContext?: { currentChannelId?: string | null }
): string {
  const raw =
    parsed.to ??
    parsed.threadId ??
    (typeof toolContext?.currentChannelId === 'string' ? toolContext.currentChannelId : undefined);
  if (!raw) {
    throw new Error('kilo-chat: conversationId (or `to`) is required');
  }
  return stripPrefix(raw);
}

export function resolveMessageId(
  parsed: { messageId?: string },
  toolContext?: { currentMessageId?: string | number | null }
): string {
  const paramId = parsed.messageId;
  const ctxId =
    toolContext?.currentMessageId != null ? String(toolContext.currentMessageId) : undefined;
  const messageId = paramId ?? ctxId;
  if (!messageId) {
    throw new Error('kilo-chat: messageId is required (explicit or via toolContext)');
  }
  return messageId;
}
