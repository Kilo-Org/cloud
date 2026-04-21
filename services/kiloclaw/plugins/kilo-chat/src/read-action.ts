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

  const { messages } = await args.client.listMessages({ conversationId, limit });

  if (messages.length === 0) {
    return { content: [{ type: 'text', text: 'No messages in this conversation.' }] };
  }

  const lines = messages.map(msg => {
    const id = typeof msg.id === 'string' ? msg.id : String(msg.id ?? '');
    const sender = typeof msg.senderId === 'string' ? msg.senderId : String(msg.senderId ?? '');
    const text = typeof msg.text === 'string' ? msg.text : '';
    return `[${id}] ${sender}: ${text}`;
  });

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
