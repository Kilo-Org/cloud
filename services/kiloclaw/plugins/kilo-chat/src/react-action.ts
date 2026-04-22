import { emojify, get } from 'node-emoji';
import type { KiloChatClient } from './client.js';
import { reactActionParams, resolveConversationId, resolveMessageId } from './action-schemas.js';

/**
 * Common shortcode aliases that differ between GitHub/Slack and node-emoji v2.
 * node-emoji v2 uses `+1` for thumbs-up while most chat platforms use `thumbsup`.
 */
const SHORTCODE_ALIASES: Record<string, string> = {
  thumbsup: '+1',
  thumbs_up: '+1',
  thumbsdown: '-1',
  thumbs_down: '-1',
};

/**
 * Normalize an emoji string for the kilo-chat service.
 *
 * - Raw unicode: passed through unchanged.
 * - Bare shortcode like "thumbsup": expanded to unicode if known.
 * - ":colon-wrapped:" shortcode: expanded to unicode if known.
 * - Empty string: passed through unchanged (interpreted upstream as a remove signal).
 * - Unknown shortcode: passed through unchanged (service will reject if it doesn't
 *   match its own validation rules).
 */
export function normalizeEmoji(input: string): string {
  if (input === '') return '';

  // Try direct unicode passthrough — if it already contains non-ASCII, assume emoji.
  if (/[^\x00-\x7F]/.test(input)) return input;

  // Strip optional colons for uniform lookup.
  const bare = input.replace(/^:(.+):$/, '$1');

  // Check alias map first.
  const aliased = SHORTCODE_ALIASES[bare] ?? bare;

  // Try direct get() lookup (handles bare shortcodes).
  const direct = get(aliased);
  if (direct != null) return direct;

  // Try emojify with colon wrapping.
  const wrapped = `:${aliased}:`;
  const expanded = emojify(wrapped, { fallback: '' });
  if (expanded !== '' && expanded !== wrapped) return expanded;

  // Unknown — return original input unchanged.
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
  const parsed = reactActionParams.safeParse(args.params);
  const conversationId = resolveConversationId(parsed.success ? parsed.data : {}, args.toolContext);
  const messageId = resolveMessageId(parsed.success ? parsed.data : {}, args.toolContext);

  const rawEmoji = parsed.success && typeof parsed.data.emoji === 'string' ? parsed.data.emoji : '';
  const removeExplicit = parsed.success && parsed.data.remove === true;

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
