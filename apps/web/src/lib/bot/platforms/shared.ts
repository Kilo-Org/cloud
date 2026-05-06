import type { Message } from 'chat';

export const MAX_MESSAGE_TEXT_LENGTH = 400;

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
