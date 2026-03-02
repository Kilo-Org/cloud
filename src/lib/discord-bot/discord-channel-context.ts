import 'server-only';
import { DISCORD_BOT_TOKEN } from '@/lib/config.server';
import { captureException } from '@sentry/nextjs';

export type DiscordEventContext = {
  channelId: string;
  guildId: string;
  userId: string;
  messageId: string;
};

export type DiscordChannelInfo = {
  id: string;
  name: string | null;
  type: number; // 0=text, 11=public_thread, 12=private_thread, 1=DM, etc.
  topic: string | null;
};

export type DiscordMessageForPrompt = {
  id: string;
  userId: string | null;
  content: string;
  timestamp: string;
};

export type DiscordConversationContext = {
  channel: DiscordChannelInfo | null;
  recentMessages: DiscordMessageForPrompt[];
  errors: string[];
};

type DiscordApiChannel = {
  id: string;
  name?: string;
  type: number;
  topic?: string | null;
};

type DiscordApiMessage = {
  id: string;
  content: string;
  timestamp: string;
  author: { id: string; username: string; bot?: boolean };
};

async function fetchDiscordApi<T>(
  path: string
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  if (!DISCORD_BOT_TOKEN) {
    return { ok: false, error: 'DISCORD_BOT_TOKEN is not configured' };
  }

  try {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `Discord API ${response.status}: ${errorText}` };
    }

    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

async function getChannelInfo(
  channelId: string
): Promise<{ ok: true; channel: DiscordChannelInfo } | { ok: false; error: string }> {
  const result = await fetchDiscordApi<DiscordApiChannel>(`/channels/${channelId}`);
  if (!result.ok) return result;

  return {
    ok: true,
    channel: {
      id: result.data.id,
      name: result.data.name ?? null,
      type: result.data.type,
      topic: result.data.topic ?? null,
    },
  };
}

async function getChannelMessages(
  channelId: string,
  limit: number
): Promise<{ ok: true; messages: DiscordMessageForPrompt[] } | { ok: false; error: string }> {
  const result = await fetchDiscordApi<DiscordApiMessage[]>(
    `/channels/${channelId}/messages?limit=${limit}`
  );
  if (!result.ok) return result;

  const messages = result.data.map(m => ({
    id: m.id,
    userId: m.author.id,
    content: m.content,
    timestamp: m.timestamp,
  }));

  return { ok: true, messages };
}

export async function getDiscordConversationContext(
  context: DiscordEventContext,
  limits?: { channelMessages?: number }
): Promise<DiscordConversationContext> {
  const channelMessagesLimit = limits?.channelMessages ?? 12;
  const errors: string[] = [];

  const [channelInfoResult, messagesResult] = await Promise.all([
    getChannelInfo(context.channelId),
    getChannelMessages(context.channelId, channelMessagesLimit),
  ]);

  const channel = channelInfoResult.ok ? channelInfoResult.channel : null;
  if (!channelInfoResult.ok) {
    errors.push(`channel info: ${channelInfoResult.error}`);
  }

  const recentMessages = messagesResult.ok ? messagesResult.messages : [];
  if (!messagesResult.ok) {
    errors.push(`channel messages: ${messagesResult.error}`);
  }

  if (errors.length > 0) {
    captureException(new Error('Failed to fetch Discord conversation context'), {
      level: 'warning',
      tags: { source: 'discord_conversation_context' },
      extra: {
        guildId: context.guildId,
        channelId: context.channelId,
        errors,
      },
    });
  }

  return { channel, recentMessages, errors };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}...`;
}

function getChannelTypeLabel(type: number): string {
  switch (type) {
    case 0:
      return 'text channel';
    case 1:
      return 'DM';
    case 2:
      return 'voice channel';
    case 11:
      return 'public thread';
    case 12:
      return 'private thread';
    default:
      return 'channel';
  }
}

export function formatDiscordConversationContextForPrompt(
  context: DiscordConversationContext,
  eventContext: DiscordEventContext
): string {
  const lines: string[] = ['\n\nDiscord context for this conversation:'];

  if (context.channel) {
    const channelLabel = context.channel.name
      ? `#${context.channel.name}`
      : getChannelTypeLabel(context.channel.type);

    lines.push(
      `- Channel: ${channelLabel} (id: ${context.channel.id}, type: ${getChannelTypeLabel(context.channel.type)})`
    );
    if (context.channel.topic) {
      lines.push(`- Channel topic: ${truncate(context.channel.topic, 400)}`);
    }
  } else {
    lines.push(`- Channel: (id: ${eventContext.channelId})`);
  }

  if (context.recentMessages.length > 0) {
    lines.push('\nRecent channel messages (most recent first):');
    for (const msg of context.recentMessages) {
      const userPart = msg.userId ? `<@${msg.userId}>` : 'unknown-user';
      const text = truncate(msg.content.replace(/\s+/g, ' ').trim(), 400);
      if (text) {
        lines.push(`- [${msg.timestamp}] ${userPart}: ${text}`);
      }
    }
  }

  if (context.errors.length > 0) {
    lines.push('\nNote: Some Discord context could not be fetched:');
    lines.push(...context.errors.map(e => `- ${e}`));
  }

  return lines.join('\n');
}
