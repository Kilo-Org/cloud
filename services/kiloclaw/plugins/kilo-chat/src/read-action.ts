import type { KiloChatClient } from './client.js';
import { readActionParams, resolveConversationId } from './action-schemas.js';

export type HandleKiloChatReadActionParams = {
  params: Record<string, unknown>;
  toolContext?: { currentChannelId?: string | null };
  client: KiloChatClient;
};

export async function handleKiloChatReadAction(
  args: HandleKiloChatReadActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const parsed = readActionParams.safeParse(args.params);
  const conversationId = resolveConversationId(parsed.success ? parsed.data : {}, args.toolContext);

  const limit = parsed.success ? parsed.data.limit : undefined;
  const before = parsed.success ? parsed.data.before : undefined;

  const { messages } = await args.client.listMessages({ conversationId, limit, before });

  if (messages.length === 0) {
    return { content: [{ type: 'text', text: 'No messages in this conversation.' }] };
  }

  const lines = messages.map(msg => {
    const id = typeof msg.id === 'string' ? msg.id : String(msg.id ?? '');
    const sender = typeof msg.senderId === 'string' ? msg.senderId : String(msg.senderId ?? '');
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks
      .filter(
        (b: unknown): b is { type: string; text: string } =>
          typeof b === 'object' &&
          b !== null &&
          'text' in b &&
          typeof (b as Record<string, unknown>).text === 'string'
      )
      .map(b => b.text)
      .join('');
    const updatedAtRaw = msg.updatedAt;
    const timestamp =
      typeof updatedAtRaw === 'number' ? ` (${new Date(updatedAtRaw).toISOString()})` : '';
    return `[${id}] ${sender}${timestamp}: ${text}`;
  });

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
