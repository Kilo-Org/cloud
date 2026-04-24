import 'server-only';
import { after } from 'next/server';
import { bot } from '@/lib/bot';

type Platform = keyof typeof bot.webhooks;

export function cloneRequestWithBody(request: Request, body: BodyInit): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
}

export function handleWebhook(platform: string, request: Request): Response | Promise<Response> {
  const handler = bot.webhooks[platform as Platform];
  if (!handler) {
    return new Response('Unknown platform', { status: 404 });
  }

  return handler(request, {
    waitUntil: task => after(() => task),
  });
}
