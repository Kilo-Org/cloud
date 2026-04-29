import { readStringParam } from 'openclaw/plugin-sdk/agent-runtime';
import type { KiloChatClient } from './client.js';

export type HandleKiloChatCreateConversationActionParams = {
  params: Record<string, unknown>;
  client: KiloChatClient;
};

export async function handleKiloChatCreateConversationAction(
  args: HandleKiloChatCreateConversationActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const name = readStringParam(args.params, 'name');
  const membersRaw = readStringParam(args.params, 'additionalMembers');
  const additionalMembers = membersRaw
    ? membersRaw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : undefined;

  const { conversationId } = await args.client.createConversation({
    title: name,
    additionalMembers,
  });

  const text = name
    ? `Created conversation "${name}" (${conversationId})`
    : `Created conversation ${conversationId}`;

  return { content: [{ type: 'text', text }] };
}
