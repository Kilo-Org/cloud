import { readNumberParam, readStringParam } from 'openclaw/plugin-sdk/agent-runtime';
import type { KiloChatClient } from './client.js';
import { resolveConversationId } from './action-schemas.js';

export type HandleKiloChatReadActionParams = {
  params: Record<string, unknown>;
  toolContext?: { currentChannelId?: string | null };
  client: KiloChatClient;
};

export async function handleKiloChatReadAction(
  args: HandleKiloChatReadActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const conversationId = resolveConversationId(args.params, args.toolContext);
  const limit = readNumberParam(args.params, 'limit');
  const before = readStringParam(args.params, 'before');

  const { messages } = await args.client.listMessages({ conversationId, limit, before });

  if (messages.length === 0) {
    return { content: [{ type: 'text', text: 'No messages in this conversation.' }] };
  }

  const lines = messages.map(msg => {
    const text = (msg.content ?? [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    const timestamp =
      typeof msg.updatedAt === 'number' ? ` (${new Date(msg.updatedAt).toISOString()})` : '';
    return `[${msg.id}] ${msg.senderId}${timestamp}: ${text}`;
  });

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
