import 'server-only';
import { db } from '@/lib/drizzle';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Expected ${description}`);
  return value;
}

function requireString(value: unknown, description: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`Expected ${description}`);
}

export function getSlackTeamIdFromEventsApiBody(body: unknown): string {
  const parsedBody = requireRecord(body, 'Slack Events API body');
  return requireString(parsedBody.team_id, 'Slack Events API body.team_id');
}

export function getSlackTeamIdFromInteractivityRawBody(rawBody: string): string {
  const payload = new URLSearchParams(rawBody).get('payload');
  if (!payload) throw new Error('Expected Slack interactivity payload');

  const parsed: unknown = JSON.parse(payload);
  const parsedPayload = requireRecord(parsed, 'Slack interactivity payload');

  if (typeof parsedPayload.team_id === 'string' && parsedPayload.team_id.length > 0) {
    return parsedPayload.team_id;
  }

  if (isRecord(parsedPayload.team)) {
    return requireString(parsedPayload.team.id, 'Slack interactivity payload.team.id');
  }

  throw new Error('Expected Slack interactivity payload.team.id or payload.team_id');
}

export async function ensureSlackIntegrationSyncedForNewBotInfra(teamId: string): Promise<void> {
  let integrationId: string | undefined;

  try {
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.SLACK),
          eq(platform_integrations.platform_installation_id, teamId)
        )
      )
      .limit(1);

    if (!integration) return;
    integrationId = integration.id;

    const { syncSlackPlatformIntegrationToSdk } = await import('@/lib/bot/slack-installation-sync');
    const synced = await syncSlackPlatformIntegrationToSdk(integration);

    if (!synced) {
      console.error('[SlackBot:Sync] Could not sync Slack integration to Chat SDK installation', {
        integrationId,
        teamId,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SlackBot:Sync] Failed to sync Slack integration to Chat SDK installation', {
      errorMessage,
      integrationId,
      teamId,
    });
  }
}
