import type { KiloChatClient } from './client.js';
import { resolveConversationId, resolveMessageId } from './action-schemas.js';

export type HandleKiloChatDeleteActionParams = {
  params: Record<string, unknown>;
  toolContext?: {
    currentChannelId?: string | null;
    currentMessageId?: string | number | null;
  };
  client: KiloChatClient;
};

export async function handleKiloChatDeleteAction(
  args: HandleKiloChatDeleteActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const conversationId = resolveConversationId(args.params, args.toolContext);
  const messageId = resolveMessageId(args.params, args.toolContext);

  await args.client.deleteMessage({ conversationId, messageId });

  return {
    content: [{ type: 'text', text: `Deleted ${messageId}` }],
  };
}
