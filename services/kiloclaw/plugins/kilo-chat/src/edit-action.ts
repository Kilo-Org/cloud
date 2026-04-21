import type { KiloChatClient } from './client.js';

export type HandleKiloChatEditActionParams = {
  params: Record<string, unknown>;
  toolContext?: {
    currentChannelId?: string | null;
    currentMessageId?: string | number | null;
  };
  client: KiloChatClient;
};

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function stripPrefix(raw: string): string {
  return raw.trim().replace(/^kilo-chat:/i, '');
}

export async function handleKiloChatEditAction(
  args: HandleKiloChatEditActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const raw =
    readString(args.params, 'to') ??
    (typeof args.toolContext?.currentChannelId === 'string'
      ? args.toolContext.currentChannelId
      : undefined);
  if (!raw) {
    throw new Error('kilo-chat: conversationId (or `to`) is required');
  }
  const conversationId = stripPrefix(raw);

  const paramMessageId = readString(args.params, 'messageId');
  const ctxMessageId =
    args.toolContext?.currentMessageId != null
      ? String(args.toolContext.currentMessageId)
      : undefined;
  const messageId = paramMessageId ?? ctxMessageId;
  if (!messageId) {
    throw new Error('kilo-chat: messageId is required (explicit or via toolContext)');
  }

  const text = readString(args.params, 'text');
  if (!text) {
    throw new Error('kilo-chat: text is required for edit action');
  }

  const result = await args.client.editMessage({
    conversationId,
    messageId,
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  });

  if (result.stale) {
    return {
      content: [
        {
          type: 'text',
          text: `Edit of ${messageId} was stale — the message was updated by someone else`,
        },
      ],
    };
  }

  return {
    content: [{ type: 'text', text: `Edited ${messageId}` }],
  };
}
