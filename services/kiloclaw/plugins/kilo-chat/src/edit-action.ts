import type { KiloChatClient } from './client.js';
import { editActionParams, resolveConversationId, resolveMessageId } from './action-schemas.js';

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
  const parsed = editActionParams.safeParse(args.params);
  const conversationId = resolveConversationId(parsed.success ? parsed.data : {}, args.toolContext);
  const messageId = resolveMessageId(parsed.success ? parsed.data : {}, args.toolContext);

  const text = parsed.success ? parsed.data.text : undefined;
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
