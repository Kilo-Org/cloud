import { readStringParam } from 'openclaw/plugin-sdk/agent-runtime';

export function stripPrefix(raw: string): string {
  return raw.trim().replace(/^kilo-chat:/i, '');
}

export function resolveConversationId(
  params: Record<string, unknown>,
  toolContext?: { currentChannelId?: string | null }
): string {
  const raw =
    readStringParam(params, 'to') ??
    (typeof toolContext?.currentChannelId === 'string' ? toolContext.currentChannelId : undefined);
  if (!raw) {
    throw new Error('kilo-chat: conversationId (or `to`) is required');
  }
  return stripPrefix(raw);
}

export function resolveMessageId(
  params: Record<string, unknown>,
  toolContext?: { currentMessageId?: string | number | null }
): string {
  const paramId = readStringParam(params, 'messageId') ?? readStringParam(params, 'message_id');
  const ctxId =
    toolContext?.currentMessageId != null ? String(toolContext.currentMessageId) : undefined;
  const messageId = paramId ?? ctxId;
  if (!messageId) {
    throw new Error('kilo-chat: messageId is required (explicit or via toolContext)');
  }
  return messageId;
}
