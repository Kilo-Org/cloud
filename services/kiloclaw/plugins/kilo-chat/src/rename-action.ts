import { readStringParam } from 'openclaw/plugin-sdk/agent-runtime';
import type { KiloChatClient } from './client.js';
import { resolveConversationId } from './action-schemas.js';

export type HandleKiloChatRenameActionParams = {
  params: Record<string, unknown>;
  toolContext?: {
    currentChannelId?: string | null;
  };
  client: KiloChatClient;
};

export async function handleKiloChatRenameAction(
  args: HandleKiloChatRenameActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const conversationId = resolveConversationId(args.params, args.toolContext);

  const name = readStringParam(args.params, 'name');
  if (!name) {
    throw new Error('kilo-chat: name is required');
  }

  await args.client.renameConversation({ conversationId, title: name });

  return {
    content: [{ type: 'text', text: `Renamed conversation ${conversationId} to "${name}"` }],
  };
}
