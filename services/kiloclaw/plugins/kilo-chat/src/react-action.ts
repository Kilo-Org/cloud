import { emojify, get } from 'node-emoji';
import { readStringParam } from 'openclaw/plugin-sdk/agent-runtime';
import type { KiloChatClient } from './client.js';
import { resolveConversationId, resolveMessageId } from './action-schemas.js';

const SHORTCODE_ALIASES: Record<string, string> = {
  thumbsup: '+1',
  thumbs_up: '+1',
  thumbsdown: '-1',
  thumbs_down: '-1',
};

export function normalizeEmoji(input: string): string {
  if (input === '') return '';
  if (/[^\x00-\x7F]/.test(input)) return input;
  const bare = input.replace(/^:(.+):$/, '$1');
  const aliased = SHORTCODE_ALIASES[bare] ?? bare;
  const direct = get(aliased);
  if (direct != null) return direct;
  const wrapped = `:${aliased}:`;
  const expanded = emojify(wrapped, { fallback: '' });
  if (expanded !== '' && expanded !== wrapped) return expanded;
  return input;
}

export type HandleKiloChatReactActionParams = {
  action: string;
  cfg: unknown;
  params: Record<string, unknown>;
  toolContext?: {
    currentChannelId?: string | null;
    currentMessageId?: string | number | null;
  };
  client: KiloChatClient;
};

export type HandleKiloChatReactActionResult =
  | {
      content: Array<{ type: 'text'; text: string }>;
      details: { added: true; id: string; emoji: string };
    }
  | {
      content: Array<{ type: 'text'; text: string }>;
      details: { removed: true; emoji: string };
    };

export async function handleKiloChatReactAction(
  args: HandleKiloChatReactActionParams
): Promise<HandleKiloChatReactActionResult> {
  const conversationId = resolveConversationId(args.params, args.toolContext);
  const messageId = resolveMessageId(args.params, args.toolContext);

  const rawEmoji = readStringParam(args.params, 'emoji') ?? '';
  const removeExplicit = args.params.remove === true;

  if (removeExplicit) {
    const emoji = normalizeEmoji(rawEmoji);
    if (emoji === '') {
      throw new Error('kilo-chat: remove requires a specific emoji');
    }
    await args.client.removeReaction({ conversationId, messageId, emoji });
    return {
      content: [{ type: 'text', text: `Removed ${emoji} from ${messageId}` }],
      details: { removed: true, emoji },
    };
  }

  if (rawEmoji === '') {
    throw new Error('kilo-chat: emoji is required');
  }
  const emoji = normalizeEmoji(rawEmoji);
  if (emoji === '') {
    throw new Error('kilo-chat: emoji is required');
  }
  const { id } = await args.client.addReaction({ conversationId, messageId, emoji });
  return {
    content: [{ type: 'text', text: `Reacted ${emoji} to ${messageId}` }],
    details: { added: true, id, emoji },
  };
}
