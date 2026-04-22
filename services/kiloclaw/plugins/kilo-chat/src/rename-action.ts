import type { KiloChatClient } from './client.js';
import { renameActionParams, resolveConversationId } from './action-schemas.js';

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
  const parsed = renameActionParams.safeParse(args.params);
  const conversationId = resolveConversationId(parsed.success ? parsed.data : {}, args.toolContext);

  const title = parsed.success
    ? (parsed.data.title ?? parsed.data.threadName ?? parsed.data.name ?? parsed.data.text)
    : undefined;
  if (!title) {
    throw new Error('kilo-chat: title is required');
  }

  await args.client.renameConversation({ conversationId, title });

  return {
    content: [{ type: 'text', text: `Renamed conversation ${conversationId} to "${title}"` }],
  };
}
