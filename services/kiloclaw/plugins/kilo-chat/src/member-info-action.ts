import type { KiloChatClient } from './client.js';

export type HandleKiloChatMemberInfoActionParams = {
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

export async function handleKiloChatMemberInfoAction(
  args: HandleKiloChatMemberInfoActionParams
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

  const { members } = await args.client.getMembers({ conversationId });

  const lines = members.map(m => `- ${m.id} (${m.kind})`);
  const text = `Members (${members.length}):\n${lines.join('\n')}`;

  return { content: [{ type: 'text', text }] };
}
