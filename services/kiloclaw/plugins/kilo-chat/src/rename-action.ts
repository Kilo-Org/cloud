import { readStringParam } from 'openclaw/plugin-sdk/agent-runtime';
import type { KiloChatClient } from './client.js';
import { stripPrefix } from './action-schemas.js';

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
  // Prefer the explicit, semantic params over `to`. The OpenClaw message-tool
  // runtime will inject `toolContext.currentChannelId` as `to` whenever no
  // registered target alias is present, which would otherwise cause us to
  // silently rename the active conversation instead of the one the caller
  // specified via `groupId`/`conversationId`.
  const raw =
    readStringParam(args.params, 'groupId') ??
    readStringParam(args.params, 'conversationId') ??
    readStringParam(args.params, 'to');
  if (!raw) {
    throw new Error('kilo-chat: groupId is required for renameGroup');
  }
  const conversationId = stripPrefix(raw);

  const name = readStringParam(args.params, 'name');
  if (!name) {
    throw new Error('kilo-chat: name is required');
  }

  await args.client.renameConversation({ conversationId, title: name });

  return {
    content: [{ type: 'text', text: `Renamed conversation ${conversationId} to "${name}"` }],
  };
}
