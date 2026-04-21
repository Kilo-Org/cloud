import type { KiloChatClient } from './client.js';

export type HandleKiloChatReadActionParams = {
  params: Record<string, unknown>;
  toolContext?: { currentChannelId?: string | null };
  client: KiloChatClient;
};

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function stripPrefix(raw: string): string {
  return raw.trim().replace(/^kilo-chat:/i, '');
}

export async function handleKiloChatReadAction(
  args: HandleKiloChatReadActionParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const raw =
    readString(args.params, 'to') ??
    (typeof args.toolContext?.currentChannelId === 'string'
      ? args.toolContext.currentChannelId
      : undefined);
  if (!raw) {
    throw new Error('kilo-chat: conversationId (or `to`) is required');
  }
  const conversationId = stripPrefix(raw);

  const limitRaw = args.params.limit;
  const limit = typeof limitRaw === 'number' ? limitRaw : undefined;
  const before = readString(args.params, 'before');

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
    const updatedAtRaw = (msg as Record<string, unknown>).updatedAt;
    const timestamp =
      typeof updatedAtRaw === 'number' ? ` (${new Date(updatedAtRaw).toISOString()})` : '';
    return `[${id}] ${sender}${timestamp}: ${text}`;
  });

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
