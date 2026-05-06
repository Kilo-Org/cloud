import { type PlatformIdentity } from '@/lib/bot-identity';
import { db } from '@/lib/drizzle';
import { eq, and, sql } from 'drizzle-orm';
import { platform_integrations, type PlatformIntegration } from '@kilocode/db';
import type { Message, Thread } from 'chat';
import type { GitHubRawMessage } from '@chat-adapter/github';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { type SlackEvent } from '@chat-adapter/slack';

type GetGitHubInstallationId = (thread: Thread) => Promise<string | number | null | undefined>;

export type GitHubRepositoryReference = {
  id: number | null;
  fullName: string | null;
};

function parseGitHubRepositoryFullName(id: string | undefined): string | null {
  if (!id) return null;

  const match = id.match(/^github:([^/]+\/[^:]+)(?::|$)/);
  if (!match) return null;

  return match[1] ?? null;
}

function getGitHubRepositoryReferenceFromRaw(raw: unknown): GitHubRepositoryReference {
  const repository = (raw as Partial<GitHubRawMessage>).repository;

  return {
    id: repository?.id ?? null,
    fullName: repository?.full_name ?? null,
  };
}

export function getGitHubRepositoryReference(
  thread: Thread,
  message: Message
): GitHubRepositoryReference {
  const rawReference = getGitHubRepositoryReferenceFromRaw(message.raw);
  return {
    id: rawReference.id,
    fullName:
      rawReference.fullName ??
      parseGitHubRepositoryFullName(thread.id) ??
      parseGitHubRepositoryFullName(thread.channelId),
  };
}

function getSlackTeamId(message: Message<SlackEvent>): string {
  const teamId = message.raw.team_id ?? message.raw.team;

  if (!teamId) throw new Error('Expected a teamId in message.raw');

  return teamId;
}

/**
 * Extract platform identity coordinates from any adapter's message.
 * Extend the switch for Discord / Teams / Google Chat / etc.
 */
export async function getPlatformIdentity(
  thread: Thread,
  message: Message,
  getGitHubInstallationId: GetGitHubInstallationId
): Promise<PlatformIdentity> {
  const platform = thread.adapter.name;

  switch (platform) {
    case PLATFORM.GITHUB: {
      const teamId = await getGitHubInstallationId(thread);

      if (!teamId) {
        throw new Error(`Could not find GitHub installation ID for thread ${thread.id}`);
      }

      return {
        platform: PLATFORM.GITHUB,
        teamId: teamId.toString(),
        userId: message.author.userId,
      };
    }
    case PLATFORM.SLACK: {
      const teamId = getSlackTeamId(message as Message<SlackEvent>);
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

/**
 * Canary gate for the GitHub bot path. Driven by `metadata.bot_enabled` on the
 * platform integration row so we can enable the bot per-installation without a
 * schema migration. Defaults to false: existing GitHub integrations are not
 * affected until an operator opts them in by setting the flag to true.
 */
export function isGitHubBotEnabled(integration: PlatformIntegration): boolean {
  const metadata = (integration.metadata ?? {}) as { bot_enabled?: unknown };
  return metadata.bot_enabled === true;
}

export function isGitHubRepositoryLinked(
  integration: PlatformIntegration,
  repository: GitHubRepositoryReference
): boolean {
  if (repository.id === null && repository.fullName === null) return false;

  if (integration.repository_access === 'all') return true;
  if (integration.repository_access !== 'selected') return false;

  const repositories = integration.repositories ?? [];
  return repositories.some(linkedRepository => {
    if (repository.id !== null && linkedRepository.id === repository.id) return true;

    return (
      repository.fullName !== null &&
      linkedRepository.full_name.toLowerCase() === repository.fullName.toLowerCase()
    );
  });
}

export function getBotDocumentationUrl(platform: string): string {
  switch (platform) {
    //TODO(remon): Update when we have specific docs pages for other platforms
    default:
      return 'https://kilo.ai/docs/code-with-ai/platforms/slack';
  }
}
