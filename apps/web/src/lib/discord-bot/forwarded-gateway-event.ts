import { isDiscordSnowflake } from '@/lib/discord-bot/discord-id';

export type ForwardedGatewayEvent = {
  type: 'GATEWAY_MESSAGE_CREATE';
  timestamp: number;
  botUserId: string | null;
  data: {
    id: string;
    content: string;
    channel_id: string;
    guild_id: string;
    author: { id: string; username: string; bot?: boolean };
    mentions?: Array<{ id: string }>;
    message_reference?: { message_id: string };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseForwardedGatewayMessageEvent(value: unknown): ForwardedGatewayEvent | null {
  if (!isRecord(value) || value.type !== 'GATEWAY_MESSAGE_CREATE') {
    return null;
  }

  if (typeof value.timestamp !== 'number') {
    return null;
  }

  const botUserId = value.botUserId;
  if (botUserId !== null && (typeof botUserId !== 'string' || !isDiscordSnowflake(botUserId))) {
    return null;
  }

  const data = value.data;
  if (!isRecord(data)) {
    return null;
  }

  const author = data.author;
  if (!isRecord(author)) {
    return null;
  }

  if (
    typeof data.id !== 'string' ||
    !isDiscordSnowflake(data.id) ||
    typeof data.content !== 'string' ||
    typeof data.channel_id !== 'string' ||
    !isDiscordSnowflake(data.channel_id) ||
    typeof data.guild_id !== 'string' ||
    !isDiscordSnowflake(data.guild_id) ||
    typeof author.id !== 'string' ||
    !isDiscordSnowflake(author.id) ||
    typeof author.username !== 'string'
  ) {
    return null;
  }

  if (author.bot !== undefined && typeof author.bot !== 'boolean') {
    return null;
  }

  const mentions = data.mentions;
  let validatedMentions: Array<{ id: string }> | undefined;
  if (mentions !== undefined) {
    if (!Array.isArray(mentions)) {
      return null;
    }

    const nextMentions: Array<{ id: string }> = [];
    for (const mention of mentions) {
      if (!isRecord(mention) || typeof mention.id !== 'string' || !isDiscordSnowflake(mention.id)) {
        return null;
      }
      nextMentions.push({ id: mention.id });
    }
    validatedMentions = nextMentions;
  }

  const messageReference = data.message_reference;
  let validatedMessageReference: { message_id: string } | undefined;
  if (messageReference !== undefined) {
    if (
      !isRecord(messageReference) ||
      typeof messageReference.message_id !== 'string' ||
      !isDiscordSnowflake(messageReference.message_id)
    ) {
      return null;
    }
    validatedMessageReference = { message_id: messageReference.message_id };
  }

  return {
    type: 'GATEWAY_MESSAGE_CREATE',
    timestamp: value.timestamp,
    botUserId,
    data: {
      id: data.id,
      content: data.content,
      channel_id: data.channel_id,
      guild_id: data.guild_id,
      author: {
        id: author.id,
        username: author.username,
        bot: author.bot,
      },
      mentions: validatedMentions,
      message_reference: validatedMessageReference,
    },
  };
}
