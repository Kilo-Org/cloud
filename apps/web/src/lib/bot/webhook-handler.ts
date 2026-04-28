import 'server-only';
import { after } from 'next/server';
import { bot } from '@/lib/bot';
import { markSlackInstallationRequiresReinstall } from '@/lib/integrations/slack-service';

type Platform = keyof typeof bot.webhooks;

export function cloneRequestWithBody(request: Request, body: BodyInit): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
}

function getSlackTeamIdFromBody(body: string, contentType: string): string | undefined {
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(body);
    const teamId = params.get('team_id');
    if (teamId) return teamId;

    const payload = params.get('payload');
    if (!payload) return undefined;

    try {
      const parsed: unknown = JSON.parse(payload);
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      if (!('team' in parsed) || typeof parsed.team !== 'object' || parsed.team === null) {
        return undefined;
      }
      const team = parsed.team;
      if (!('id' in team) || typeof team.id !== 'string') return undefined;
      return team.id;
    } catch {
      return undefined;
    }
  }

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    if (!('team_id' in parsed) || typeof parsed.team_id !== 'string') return undefined;
    return parsed.team_id;
  } catch {
    return undefined;
  }
}

async function handleSlackWebhookError(error: unknown, teamId: string | undefined): Promise<void> {
  if (!teamId) return;
  try {
    await markSlackInstallationRequiresReinstall(teamId, error);
  } catch (markError) {
    console.error('[Webhook] Failed to mark Slack installation as requires_reinstall:', markError);
  }
}

export async function handleWebhook(platform: string, request: Request): Promise<Response> {
  const handler = bot.webhooks[platform as Platform];
  if (!handler) {
    return new Response('Unknown platform', { status: 404 });
  }

  const body = await request.text();
  const clonedRequest = cloneRequestWithBody(request, body);
  const slackTeamId =
    platform === 'slack'
      ? getSlackTeamIdFromBody(body, request.headers.get('content-type') ?? '')
      : undefined;

  try {
    return await handler(clonedRequest, {
      waitUntil: task =>
        after(async () => {
          try {
            await task;
          } catch (error) {
            await handleSlackWebhookError(error, slackTeamId);
            throw error;
          }
        }),
    });
  } catch (error) {
    await handleSlackWebhookError(error, slackTeamId);
    throw error;
  }
}
