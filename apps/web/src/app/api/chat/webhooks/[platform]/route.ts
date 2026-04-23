import { handleBotWebhookRequest } from '@/lib/bot/webhook-handler';

export const maxDuration = 800;

type RouteContext = {
  params: Promise<{ platform: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { platform } = await context.params;
  return handleBotWebhookRequest(platform, request);
}
