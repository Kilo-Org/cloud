import type { KiloChatClient } from './client.js';

export type HandleKiloChatCreateConversationActionParams = {
  params: Record<string, unknown>;
  client: KiloChatClient;
};

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export async function handleKiloChatCreateConversationAction(
  args: HandleKiloChatCreateConversationActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const title = readString(args.params, 'title');
  const membersRaw = readString(args.params, 'members');
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
