import type { KiloChatClient } from './client.js';

export type HandleKiloChatRenameActionParams = {
  params: Record<string, unknown>;
  toolContext?: {
    currentChannelId?: string | null;
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

export async function handleKiloChatRenameAction(
  args: HandleKiloChatRenameActionParams
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

  const title = readString(args.params, 'title');
  if (!title) {
    throw new Error('kilo-chat: title is required');
  }

  await args.client.renameConversation({ conversationId, title });

  return {
    content: [{ type: 'text', text: `Renamed conversation ${conversationId} to "${title}"` }],
  };
}
