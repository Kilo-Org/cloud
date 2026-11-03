import type { Platform } from '@/lib/integrations/core/constants';
import type { Message } from 'chat';

export const MAX_MESSAGE_TEXT_LENGTH = 400;

const PLATFORM_CONTEXT_TAG = 'platform_conversation_context';

/** Escape every closing sequence for `tag` in `text`. Case-insensitive. */
export function escapeClosingTag(tag: string, text: string): string {
  const replacement = `<\\/${tag}`;
  return text.replace(new RegExp(`</${tag}`, 'gi'), () => replacement);
}

/**
 * Wrap platform conversation context in a named block. The block body is data,
 * and an empty body produces no block at all.
 */
export function formatPlatformConversationContext(platform: Platform, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  return `<${PLATFORM_CONTEXT_TAG} platform="${platform}">\n${escapeClosingTag(
    PLATFORM_CONTEXT_TAG,
    trimmed
  )}\n</${PLATFORM_CONTEXT_TAG}>`;
}

export type ContextTriggerMessage = Pick<Message, 'author' | 'id' | 'text'> & {
  metadata?: Pick<Message['metadata'], 'dateSent'>;
};

export type FormattedMessage = {
  authorName: string;
  text: string;
  time: string;
};

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

export function sanitizeForDelimiters(text: string): string {
  return text.replace(/[<>"]/g, '').replace(/\r\n|\r/g, '\n');
}

export function formatMessage(
  msg: Message,
  maxLength: number = MAX_MESSAGE_TEXT_LENGTH
): FormattedMessage {
  const collapsed = msg.text.replace(/\s+/g, ' ').trim();
  return {
    authorName: sanitizeForDelimiters(
      msg.author.fullName || msg.author.userName || msg.author.userId
    ),
    text: sanitizeForDelimiters(truncate(collapsed, maxLength)),
    time: msg.metadata.dateSent.toISOString(),
  };
}

export function formatTriggerMessage(
  msg: ContextTriggerMessage,
  maxLength: number = MAX_MESSAGE_TEXT_LENGTH
): FormattedMessage {
  const collapsed = msg.text.replace(/\s+/g, ' ').trim();
  return {
    authorName: sanitizeForDelimiters(
      msg.author.fullName || msg.author.userName || msg.author.userId
    ),
    text: sanitizeForDelimiters(truncate(collapsed, maxLength)),
    time: msg.metadata?.dateSent.toISOString() ?? 'unknown',
  };
}

export async function collectMessages(
  iterable: AsyncIterable<Message>,
  limit: number
): Promise<Message[]> {
  const collected: Message[] = [];
  for await (const msg of iterable) {
    if (collected.length >= limit) break;
    collected.push(msg);
  }
  return collected;
}

export function formatUserMessage(msg: FormattedMessage): string {
  return `<user_message author="${msg.authorName}" time="${msg.time}">${msg.text}</user_message>`;
}
