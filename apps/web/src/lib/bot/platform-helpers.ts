import type { PlatformIdentity } from '@/lib/bot-identity';
import { db } from '@/lib/drizzle';
import { eq, and, sql } from 'drizzle-orm';
import { platform_integrations } from '@kilocode/db';
import type { Message, Thread } from 'chat';
import { PLATFORM } from '@/lib/integrations/core/constants';

type PlatformIdentityMessage = {
  author: Pick<Message['author'], 'userId'>;
  raw: unknown;
};

type PlatformIdentityOptions = {
  getGitHubInstallationId?: (thread: Pick<Thread, 'id'>) => Promise<number | string | undefined>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function readStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function getSlackTeamId(message: { raw: unknown }): string {
  if (!isRecord(message.raw)) throw new Error('Expected a teamId in message.raw');

  const teamId =
    readStringProperty(message.raw, 'team_id') ?? readStringProperty(message.raw, 'team');
  if (!teamId) throw new Error('Expected a teamId in message.raw');
  return teamId;
}

export function getGitHubInstallationId(message: { raw: unknown }): string {
  if (!isRecord(message.raw)) throw new Error('Expected an installation.id in message.raw');

  const installation = message.raw.installation;
  if (!isRecord(installation) || typeof installation.id !== 'number') {
    throw new Error('Expected an installation.id in message.raw');
  }

  const installationId = installation.id;
  return installationId.toString();
}

/**
 * Extract platform identity coordinates from any adapter's message.
 * Extend the switch for Discord / Teams / Google Chat / etc.
 */
export async function getPlatformIdentity(
  thread: Pick<Thread, 'id'>,
  message: PlatformIdentityMessage,
  options?: PlatformIdentityOptions
): Promise<PlatformIdentity> {
  const platform = thread.id.split(':')[0]; // "slack", "discord", "gchat", "teams", ...

  switch (platform) {
    case 'github': {
      const installationId = options?.getGitHubInstallationId
        ? await options.getGitHubInstallationId(thread)
        : getGitHubInstallationId(message);
      if (!installationId) throw new Error('Expected a GitHub installation id');
      const teamId = installationId.toString();
      return { platform: PLATFORM.GITHUB, teamId, userId: message.author.userId };
    }
    case 'slack': {
      const teamId = getSlackTeamId(message);
      return { platform: PLATFORM.SLACK, teamId, userId: message.author.userId };
    }
    default:
      throw new Error(`PlatformNotSupported: ${platform}`);
  }
}

/**
 * Look up the platform integration row for a given identity.
 * Platform-agnostic: queries by identity.platform + identity.teamId.
 */
export async function getPlatformIntegration(identity: PlatformIdentity) {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, identity.platform),
        eq(platform_integrations.platform_installation_id, identity.teamId)
      )
    )
    .limit(1);

  return integration ?? null;
}

export async function getPlatformIntegrationById(platformIntegrationId: string) {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(eq(platform_integrations.id, platformIntegrationId))
    .limit(1);

  if (!integration) {
    throw new Error(`Could not find platform integration ${platformIntegrationId}`);
  }

  return integration;
}

export async function getPlatformIntegrationByBotUserId(
  platform: string,
  botUserId: string | undefined
) {
  if (!botUserId) return null;

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, platform),
        eq(sql<string>`${platform_integrations.metadata}->>'bot_user_id'`, botUserId)
      )
    )
    .limit(1);

  return integration ?? null;
}

export function getBotDocumentationUrl(platform: string): string {
  switch (platform) {
    case PLATFORM.GITHUB:
      return 'https://kilo.ai/docs/code-with-ai/platforms/github';
    //TODO(remon): Update when we have specific docs pages for other platforms
    default:
      return 'https://kilo.ai/docs/code-with-ai/platforms/slack';
  }
}
