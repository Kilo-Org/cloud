import { readStringParam } from 'openclaw/plugin-sdk/agent-runtime';
import type { KiloChatClient } from './client.js';
import { resolveConversationId, stripPrefix } from './action-schemas.js';

export type HandleKiloChatMemberInfoActionParams = {
  params: Record<string, unknown>;
  toolContext?: { currentChannelId?: string | null };
  client: KiloChatClient;
};

export async function handleKiloChatMemberInfoAction(
  args: HandleKiloChatMemberInfoActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const conversationId = resolveConversationId(args.params, args.toolContext);

  const { members } = await args.client.getMembers({ conversationId });

  const rawTarget =
    readStringParam(args.params, 'target') ??
    readStringParam(args.params, 'memberId') ??
    readStringParam(args.params, 'userId');
  if (rawTarget) {
    const targetId = stripPrefix(rawTarget);
    const match = members.find(m => m.id === targetId);
    if (!match) {
      throw new Error(`kilo-chat: member ${targetId} is not in conversation ${conversationId}`);
    }
    const display = match.displayName ?? match.id;
    const lines = [`Member: ${display}`, `- id: ${match.id}`, `- kind: ${match.kind}`];
    if (match.displayName) lines.push(`- displayName: ${match.displayName}`);
    if (match.avatarUrl) lines.push(`- avatarUrl: ${match.avatarUrl}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  const lines = members.map(m => {
    const display = m.displayName;
    if (display) {
      return `- ${display} (${m.id}, ${m.kind})`;
    }
    return `- ${m.id} (${m.kind})`;
  });
  const text = `Members (${members.length}):\n${lines.join('\n')}`;

  return { content: [{ type: 'text', text }] };
}
