import type { KiloChatClient } from './client.js';
import { createConversationActionParams } from './action-schemas.js';

export type HandleKiloChatCreateConversationActionParams = {
  params: Record<string, unknown>;
  client: KiloChatClient;
};

export async function handleKiloChatCreateConversationAction(
  args: HandleKiloChatCreateConversationActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const parsed = createConversationActionParams.safeParse(args.params);
  const title = parsed.success ? parsed.data.title : undefined;
  const membersRaw = parsed.success ? parsed.data.members : undefined;
  const additionalMembers = membersRaw
    ? membersRaw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : undefined;

  const { conversationId } = await args.client.createConversation({
    title,
    additionalMembers,
  });

  const text = title
    ? `Created conversation "${title}" (${conversationId})`
    : `Created conversation ${conversationId}`;

  return { content: [{ type: 'text', text }] };
}
