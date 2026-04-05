import crypto from 'crypto';
import type { NextRequest } from 'next/server';
import { after, NextResponse } from 'next/server';
import { InteractionType, InteractionResponseType } from 'discord-interactions';
import { verifyDiscordRequest } from '@/lib/discord/verify-request';
import { DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY } from '@/lib/config.server';
import { processDiscordBotMessage } from '@/lib/discord-bot';
import {
  postDiscordMessage,
  addDiscordReaction,
  removeDiscordReaction,
} from '@/lib/integrations/discord-service';
import {
  stripDiscordBotMention,
  replaceDiscordUserMentionsWithNames,
  isDiscordBotMessage,
  truncateForDiscord,
} from '@/lib/discord-bot/discord-utils';
import { getDevUserSuffix } from '@/lib/slack-bot/dev-user-info';

export const maxDuration = 800;

/**
 * Reaction emoji for processing state
 */
const PROCESSING_EMOJI = '\u23f3'; // hourglass
const COMPLETE_EMOJI = '\u2705'; // white check mark

/**
 * Forwarded Gateway event shape (from the Gateway listener)
 */
type ForwardedGatewayEvent = {
  type: string;
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

/**
 * Discord webhook handler.
 * Handles:
 * 1. Discord HTTP Interactions (PING verification, slash commands)
 * 2. Forwarded Gateway events (MESSAGE_CREATE from the Gateway listener)
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  // Check if this is a forwarded Gateway event (from our Gateway listener)
  const gatewayToken = request.headers.get('x-discord-gateway-token');
  if (gatewayToken) {
    if (!DISCORD_BOT_TOKEN || !timingSafeTokenEqual(gatewayToken, DISCORD_BOT_TOKEN)) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    const event = JSON.parse(rawBody) as ForwardedGatewayEvent;
    if (event.type === 'GATEWAY_MESSAGE_CREATE') {
      after(processGatewayMessage(event));
    }
    return new NextResponse(null, { status: 200 });
  }

  // Otherwise, this is a Discord HTTP Interaction -- verify signature
  if (!DISCORD_PUBLIC_KEY) {
    console.error('[DiscordBot:Webhook] DISCORD_PUBLIC_KEY is not configured');
    return new NextResponse('Server misconfigured', { status: 500 });
  }

  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');

  const isValid = await verifyDiscordRequest(rawBody, signature, timestamp, DISCORD_PUBLIC_KEY);
  if (!isValid) {
    console.error('[DiscordBot:Webhook] Invalid Discord signature');
    return new NextResponse('Invalid signature', { status: 401 });
  }

  const body = JSON.parse(rawBody);

  // Handle PING (Discord endpoint verification)
  if (body.type === InteractionType.PING) {
    console.log('[DiscordBot:Webhook] PING received, responding with PONG');
    return NextResponse.json({ type: InteractionResponseType.PONG });
  }

  // Handle Application Commands (slash commands) - placeholder for future
  if (body.type === InteractionType.APPLICATION_COMMAND) {
    console.log('[DiscordBot:Webhook] Slash command received:', body.data?.name);
    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: 'Kilo Bot is here! Slash command support coming soon.',
      },
    });
  }

  return new NextResponse(null, { status: 200 });
}

/**
 * Process a message forwarded from the Discord Gateway.
 * This handles @mentions of the bot in channels.
 */
async function processGatewayMessage(event: ForwardedGatewayEvent) {
  const message = event.data;
  console.log(
    '[DiscordBot:Webhook] Processing gateway message from',
    message.author.username,
    'in guild',
    message.guild_id
  );

  // Ignore bot messages
  if (isDiscordBotMessage(message)) {
    console.log('[DiscordBot:Webhook] Ignoring bot message');
    return;
  }

  // Ignore messages without a guild (DMs are not yet supported)
  if (!message.guild_id) {
    console.log('[DiscordBot:Webhook] Ignoring non-guild message');
    return;
  }

  // Check if this message mentions the bot
  const botUserId = event.botUserId;
  const mentionsBot = botUserId && message.mentions?.some(m => m.id === botUserId);
  if (!mentionsBot) {
    // Message doesn't mention the bot, ignore it
    return;
  }

  const { content, channel_id: channelId, guild_id: guildId, author, id: messageId } = message;

  // Strip the bot mention and check if there's remaining text
  const cleanedText = stripDiscordBotMention(content, botUserId);

  if (!cleanedText) {
    console.log('[DiscordBot:Webhook] No text after removing mention, ignoring');
    return;
  }

  // Resolve user mentions to display names
  const resolvedText = await replaceDiscordUserMentionsWithNames(cleanedText, guildId);

  // Add processing reaction
  await addDiscordReaction(channelId, messageId, PROCESSING_EMOJI);

  const startTime = Date.now();

  // Process through bot
  const result = await processDiscordBotMessage(resolvedText, guildId, {
    channelId,
    guildId,
    userId: author.id,
    messageId,
  });

  const responseTimeMs = Date.now() - startTime;
  console.log(`[DiscordBot:Webhook] Bot processing completed in ${responseTimeMs}ms`);

  // Post the response as a reply to the original message
  const responseWithDevInfo = result.response + getDevUserSuffix();
  const responseText = truncateForDiscord(responseWithDevInfo);
  const postResult = await postDiscordMessage(channelId, responseText, {
    messageReference: { message_id: messageId },
  });

  console.log(
    '[DiscordBot:Webhook] Response posted:',
    postResult.ok ? 'success' : postResult.error
  );

  // Replace processing reaction with complete reaction
  const [removeResult] = await Promise.all([
    removeDiscordReaction(channelId, messageId, PROCESSING_EMOJI),
    addDiscordReaction(channelId, messageId, COMPLETE_EMOJI),
  ]);
  // Retry removal once if it failed (e.g. due to rate limiting)
  if (!removeResult.ok) {
    await removeDiscordReaction(channelId, messageId, PROCESSING_EMOJI);
  }
}

function timingSafeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare a with itself to avoid leaking length via timing,
    // then return false.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
