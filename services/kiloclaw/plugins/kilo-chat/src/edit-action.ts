import { readStringParam } from 'openclaw/plugin-sdk/agent-runtime';
import type { KiloChatClient } from './client.js';
import { resolveConversationId, resolveMessageId } from './action-schemas.js';

export type HandleKiloChatEditActionParams = {
  params: Record<string, unknown>;
  toolContext?: {
    currentChannelId?: string | null;
    currentMessageId?: string | number | null;
  };
  client: KiloChatClient;
};

export async function handleKiloChatEditAction(
  args: HandleKiloChatEditActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const conversationId = resolveConversationId(args.params, args.toolContext);
  const messageId = resolveMessageId(args.params, args.toolContext);

  const message = readStringParam(args.params, 'message');
  if (!message) {
    throw new Error('kilo-chat: message is required for edit action');
  }

  const result = await args.client.editMessage({
    conversationId,
    messageId,
    content: [{ type: 'text', text: message }],
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
