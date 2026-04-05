import { after } from 'next/server';
import { bot } from '@/lib/bot';

export const maxDuration = 800;

type Platform = keyof typeof bot.webhooks;
type RouteContext = {
  params: Promise<{ platform: string }>;
};
export async function POST(request: Request, context: RouteContext) {
  const { platform } = await context.params;
  const handler = bot.webhooks[platform as Platform];
  if (!handler) {
    return new Response('Unknown platform', { status: 404 });
  }
  return handler(request, {
    waitUntil: task => after(() => task),
  });
}
