import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cloneRequestWithBody, handleBotWebhookRequest } from '@/lib/bot/webhook-handler';
import { verifySlackRequest } from '@/lib/slack/verify-request';

export const maxDuration = 800;

/**
 * Slack Events API webhook handler.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');

  if (!verifySlackRequest(rawBody, timestamp, signature)) {
    console.error('[SlackBot:Webhook] Invalid Slack signature');
    return new NextResponse('Invalid signature', { status: 401 });
  }

  const body = JSON.parse(rawBody);

  if (body.type === 'url_verification') {
    return NextResponse.json({ challenge: body.challenge });
  }

  return handleBotWebhookRequest('slack', cloneRequestWithBody(request, rawBody));
}
