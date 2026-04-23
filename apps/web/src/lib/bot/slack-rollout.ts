import 'server-only';
import { db } from '@/lib/drizzle';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

const ROUTED_INTEGRATION_IDS_ENV = 'SLACK_BOT_NEW_INFRA_PLATFORM_INTEGRATION_IDS';
const MAX_ROUTED_INTEGRATIONS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseSlackBotNewInfraIntegrationIds(value: string | undefined): string[] {
  if (!value) return [];

  const ids = new Set<string>();
  for (const id of value.split(',')) {
    const trimmed = id.trim();
    if (trimmed) ids.add(trimmed);
  }

  return Array.from(ids);
}

export function getSlackBotNewInfraIntegrationIds(): string[] {
  const ids = parseSlackBotNewInfraIntegrationIds(process.env[ROUTED_INTEGRATION_IDS_ENV]);

  console.info(ids);

  if (ids.length > MAX_ROUTED_INTEGRATIONS) {
    console.error(
      `[SlackBot:Routing] ${ROUTED_INTEGRATION_IDS_ENV} contains ${ids.length} IDs; refusing to route more than ${MAX_ROUTED_INTEGRATIONS} integrations to the new bot infra`
    );
    return [];
  }

  return ids;
}

export function isSlackBotNewInfraIntegrationIdAllowed(integrationId: string): boolean {
  return getSlackBotNewInfraIntegrationIds().includes(integrationId);
}

export function getSlackTeamIdFromEventsApiBody(body: unknown): string | null {
  if (!isRecord(body)) return null;

  const topLevelTeamId = getString(body.team_id);
  if (topLevelTeamId) return topLevelTeamId;

  const event = body.event;
  if (!isRecord(event)) return null;

  return getString(event.team);
}

export function getSlackTeamIdFromInteractivityRawBody(rawBody: string): string | null {
  const payload = new URLSearchParams(rawBody).get('payload');
  if (!payload) return null;

  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed)) return null;

    const team = parsed.team;
    if (isRecord(team)) {
      const teamId = getString(team.id);
      if (teamId) return teamId;
    }

    return getString(parsed.team_id);
  } catch {
    return null;
  }
}

export async function findSlackIntegrationRoutedToNewInfra(teamId: string) {
  const allowedIntegrationIds = getSlackBotNewInfraIntegrationIds();

  console.info(allowedIntegrationIds);
  if (allowedIntegrationIds.length === 0) return null;

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.SLACK),
        eq(platform_integrations.platform_installation_id, teamId),
        inArray(platform_integrations.id, allowedIntegrationIds)
      )
    )
    .limit(1);

  if (!integration) {
    return null;
  }

  try {
    const { syncSlackPlatformIntegrationToSdk } = await import('@/lib/bot/slack-installation-sync');
    const synced = await syncSlackPlatformIntegrationToSdk(integration);
    if (synced) return integration;

    console.error(
      '[SlackBot:Routing] Refusing to route integration to new bot infra because the SDK installation could not be synced',
      { integrationId: integration.id, teamId }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SlackBot:Routing] Failed to sync SDK installation for new bot infra routing', {
      errorMessage,
      integrationId: integration.id,
      teamId,
    });
  }

  return null;
}

export async function shouldRouteSlackEventsApiBodyToNewBotInfra(body: unknown): Promise<boolean> {
  const teamId = getSlackTeamIdFromEventsApiBody(body);
  if (!teamId) return false;

  return Boolean(await findSlackIntegrationRoutedToNewInfra(teamId));
}

export async function shouldRouteSlackInteractivityToNewBotInfra(
  rawBody: string
): Promise<boolean> {
  const teamId = getSlackTeamIdFromInteractivityRawBody(rawBody);
  if (!teamId) return false;

  return Boolean(await findSlackIntegrationRoutedToNewInfra(teamId));
}
