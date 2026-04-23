import { readStringParam } from 'openclaw/plugin-sdk/agent-runtime';

export function stripPrefix(raw: string): string {
  return raw.trim().replace(/^kilo-chat:/i, '');
}

export type ResolveConversationIdOptions = {
  allowCurrentChannelFallback?: boolean;
};

export function resolveConversationId(
  params: Record<string, unknown>,
  toolContext?: { currentChannelId?: string | null },
  options: ResolveConversationIdOptions = {}
): string {
  const { allowCurrentChannelFallback = true } = options;
  const fromParams =
    readStringParam(params, 'to') ??
    readStringParam(params, 'conversationId') ??
    readStringParam(params, 'groupId');
  const fromContext =
    allowCurrentChannelFallback && typeof toolContext?.currentChannelId === 'string'
      ? toolContext.currentChannelId
      : undefined;
  const raw = fromParams ?? fromContext;
  if (!raw) {
    throw new Error('kilo-chat: conversationId (or `to`/`groupId`) is required');
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
