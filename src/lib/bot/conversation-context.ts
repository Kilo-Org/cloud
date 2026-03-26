import type { Thread, Message, ChannelInfo } from 'chat';

const MAX_MESSAGE_TEXT_LENGTH = 400;

type ConversationContext = {
  channelName: string | null;
  isDM: boolean;
  channelTopic: string | null;
  channelPurpose: string | null;
  recentChannelMessages: FormattedMessage[];
  recentThreadMessages: FormattedMessage[];
};

type FormattedMessage = {
  authorName: string;
  text: string;
  time: string; // ISO-8601 timestamp from message.metadata.dateSent
};

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

/** Strip characters that could break XML-like structural delimiters. */
function sanitizeForDelimiters(text: string): string {
  return text.replace(/[<>"\n\r]/g, '');
}

function formatMessage(msg: Message): FormattedMessage {
  const collapsed = msg.text.replace(/\s+/g, ' ').trim();
  return {
    authorName: sanitizeForDelimiters(
      msg.author.fullName || msg.author.userName || msg.author.userId
    ),
    text: sanitizeForDelimiters(truncate(collapsed, MAX_MESSAGE_TEXT_LENGTH)),
    time: msg.metadata.dateSent.toISOString(),
  };
}

async function collectMessages(
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

/**
 * Gather conversation context from a Thread using only the chat SDK's
 * platform-agnostic APIs. Works for Slack, Discord, Teams, Google Chat, etc.
 */
export async function getConversationContext(
  thread: Thread,
  triggerMessage: Message,
  limits?: { channelMessages?: number; threadMessages?: number }
): Promise<ConversationContext> {
  const channelMessagesLimit = limits?.channelMessages ?? 12;
  const threadMessagesLimit = limits?.threadMessages ?? 12;

  // Channel metadata & messages can be fetched in parallel.
  // Thread messages come from thread.messages (newest-first), channel
  // messages from thread.channel.messages (also newest-first).
  //
  // thread.messages may fail (e.g. Slack returns thread_not_found for
  // channel-level messages that aren't part of a thread), so we catch and
  // fall back to an empty list.
  const [channelInfo, threadMessagesRaw, channelMessagesRaw] = await Promise.all([
    thread.channel.fetchMetadata().catch((): ChannelInfo | null => null),
    collectMessages(thread.messages, threadMessagesLimit).catch((): Message[] => []),
    collectMessages(thread.channel.messages, channelMessagesLimit).catch((): Message[] => []),
  ]);

  // Filter out the trigger message from thread messages so we don't
  // duplicate the user's prompt.
  const threadMessages = threadMessagesRaw
    .filter(m => m.id !== triggerMessage.id)
    .map(formatMessage)
    // thread.messages yields newest-first; reverse to chronological
    .reverse();

  // Channel messages are also newest-first; reverse to chronological.
  const channelMessages = channelMessagesRaw
    .filter(m => m.id !== triggerMessage.id)
    .map(formatMessage)
    .reverse();

  // Channel metadata may carry topic/purpose in the metadata bag.
  const metadata = channelInfo?.metadata ?? {};
  const channelTopic = typeof metadata.topic === 'string' ? metadata.topic : null;
  const channelPurpose = typeof metadata.purpose === 'string' ? metadata.purpose : null;

  return {
    channelName: channelInfo?.name ?? null,
    isDM: channelInfo?.isDM ?? thread.isDM,
    channelTopic,
    channelPurpose,
    recentChannelMessages: channelMessages,
    recentThreadMessages: threadMessages,
  };
}

/**
 * Format a ConversationContext into a string suitable for appending to the
 * system prompt. Returns an empty string when there is nothing to add.
 */
export function formatConversationContextForPrompt(ctx: ConversationContext): string {
  const lines: string[] = ['Conversation context:'];

  // Channel info — some adapters (e.g. Slack) include a leading '#' in the
  // channel name already, so strip it before re-adding to avoid '##general'.
  const name = ctx.channelName?.replace(/^#/, '');
  const channelLabel = ctx.isDM ? 'DM' : name ? `#${name}` : 'channel';
  lines.push(`- Channel: ${channelLabel}`);

  if (ctx.channelTopic) {
    lines.push(
      `- Channel topic: ${sanitizeForDelimiters(truncate(ctx.channelTopic, MAX_MESSAGE_TEXT_LENGTH))}`
    );
  }
  if (ctx.channelPurpose) {
    lines.push(
      `- Channel purpose: ${sanitizeForDelimiters(truncate(ctx.channelPurpose, MAX_MESSAGE_TEXT_LENGTH))}`
    );
  }

  // Channel messages wrapped in delimiters to distinguish user-generated
  // content from system instructions.
  if (ctx.recentChannelMessages.length > 0) {
    lines.push('\nRecent channel messages (oldest first):');
    for (const msg of ctx.recentChannelMessages) {
      lines.push(
        `<user_message author="${msg.authorName}" time="${msg.time}">${msg.text}</user_message>`
      );
    }
  }

  // Thread messages (oldest first / chronological)
  if (ctx.recentThreadMessages.length > 0) {
    lines.push('\nThread messages (oldest first):');
    for (const msg of ctx.recentThreadMessages) {
      lines.push(
        `<user_message author="${msg.authorName}" time="${msg.time}">${msg.text}</user_message>`
      );
    }
  }

  // If there's literally no context beyond the channel label, skip it
  if (lines.length <= 2 && ctx.recentChannelMessages.length === 0) {
    return '';
  }

  return lines.join('\n');
}
