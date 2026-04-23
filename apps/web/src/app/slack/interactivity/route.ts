import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cloneRequestWithBody, handleBotWebhookRequest } from '@/lib/bot/webhook-handler';
import { ensureSlackInstallationSyncedForTeam } from '@/lib/bot/slack-installation-sync';
import { getSlackTeamIdFromInteractivityRawBody } from '@/lib/slack/request-payload';
import { verifySlackRequest } from '@/lib/slack/verify-request';

/**
 * Slack Interactivity endpoint handler.
 * Handles interactive components like buttons, modals, shortcuts, etc.
 * @see https://api.slack.com/interactivity/handling
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');

  if (!verifySlackRequest(rawBody, timestamp, signature)) {
    console.error('[Slack:Interactivity] Invalid Slack signature');
    return new NextResponse('Invalid signature', { status: 401 });
  }

  try {
    const teamId = getSlackTeamIdFromInteractivityRawBody(rawBody);
    await ensureSlackInstallationSyncedForTeam(teamId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[Slack:Interactivity] Failed to sync Slack installation before forwarding', {
      errorMessage,
    });
  }

  return handleBotWebhookRequest('slack', cloneRequestWithBody(request, rawBody));
}
