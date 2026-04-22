import type { KiloChatClient } from './client.js';
import { memberInfoActionParams, resolveConversationId } from './action-schemas.js';

export type HandleKiloChatMemberInfoActionParams = {
  params: Record<string, unknown>;
  toolContext?: { currentChannelId?: string | null };
  client: KiloChatClient;
};

export async function handleKiloChatMemberInfoAction(
  args: HandleKiloChatMemberInfoActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const parsed = memberInfoActionParams.safeParse(args.params);
  const conversationId = resolveConversationId(parsed.success ? parsed.data : {}, args.toolContext);

  const { members } = await args.client.getMembers({ conversationId });

  const lines = members.map(m => {
    const display = (m as { displayName?: string | null }).displayName;
    if (display) {
      return `- ${display} (${m.id}, ${m.kind})`;
    }
    return `- ${m.id} (${m.kind})`;
  });
  const text = `Members (${members.length}):\n${lines.join('\n')}`;

  return { content: [{ type: 'text', text }] };
}
