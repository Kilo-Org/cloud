import 'server-only';
import { after } from 'next/server';
import { bot, legacySlackBot } from '@/lib/bot';

type Platform = keyof typeof bot.webhooks;

export function cloneRequestWithBody(request: Request, body: BodyInit): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
}

function handleWebhook(
  chatBot: typeof bot,
  platform: string,
  request: Request
): Response | Promise<Response> {
  const handler = chatBot.webhooks[platform as Platform];
  if (!handler) {
    return new Response('Unknown platform', { status: 404 });
  }

  return handler(request, {
    waitUntil: task => after(() => task),
  });
}

export function handleBotWebhookRequest(
  platform: string,
  request: Request
): Response | Promise<Response> {
  return handleWebhook(bot, platform, request);
}

export function handleLegacySlackBotWebhookRequest(request: Request): Response | Promise<Response> {
  return handleWebhook(legacySlackBot, 'slack', request);
}
