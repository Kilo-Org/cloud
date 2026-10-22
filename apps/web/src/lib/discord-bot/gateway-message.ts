import type { ForwardedGatewayEvent } from './forwarded-gateway-event';
import { isDiscordBotMessage, stripDiscordBotMention } from './discord-utils';

export function shouldProcessGatewayMessage(
  event: ForwardedGatewayEvent
): event is ForwardedGatewayEvent & { botUserId: string } {
  const { data: message, botUserId } = event;
  return (
    !isDiscordBotMessage(message) &&
    Boolean(message.guild_id) &&
    Boolean(botUserId) &&
    Boolean(message.mentions?.some(mention => mention.id === botUserId)) &&
    Boolean(stripDiscordBotMention(message.content, botUserId))
  );
}
