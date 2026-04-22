import type { KiloChatClient } from './client.js';
import { listConversationsActionParams } from './action-schemas.js';

export type HandleKiloChatListConversationsActionParams = {
  params: Record<string, unknown>;
  client: KiloChatClient;
};

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function handleKiloChatListConversationsAction(
  args: HandleKiloChatListConversationsActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const parsed = listConversationsActionParams.safeParse(args.params);
  const limit = parsed.success ? parsed.data.limit : undefined;
  const offset = parsed.success ? parsed.data.offset : undefined;
  const { conversations, total } = await args.client.listConversations({ limit, offset });

  if (conversations.length === 0) {
    return { content: [{ type: 'text', text: 'No conversations found.' }] };
  }

  const lines = conversations.map(c => {
    const title = c.title ? `"${c.title}" ` : '';
    const activity = c.lastActivityAt
      ? `last active ${relativeTime(c.lastActivityAt)}`
      : 'no activity';
    return `- ${title}(${c.conversationId}) — ${c.members.length} members, ${activity}`;
  });

  const text = `Conversations (${total} total):\n${lines.join('\n')}`;
  return { content: [{ type: 'text', text }] };
}
