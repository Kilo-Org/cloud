import 'server-only';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { platform_integrations, type PlatformIntegration } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { platformIntegrationHealthSql } from '@/lib/integrations/core/health';

export type CliSessionGitHubIntegration = Pick<
  PlatformIntegration,
  'id' | 'platform_installation_id' | 'github_app_type'
> & {
  platform_installation_id: string;
};

function repositoryMatches(integration: PlatformIntegration, repositoryFullName: string): boolean {
  const repositoryParts = repositoryFullName.split('/');
  if (repositoryParts.length !== 2 || repositoryParts.some(part => part.length === 0)) return false;
  const [repositoryOwner] = repositoryParts;
  if (
    !repositoryOwner ||
    integration.platform_account_login?.toLowerCase() !== repositoryOwner.toLowerCase()
  ) {
    return false;
  }
  if (integration.repository_access === 'all') return true;
  if (integration.repository_access !== 'selected') return false;
  return Boolean(
    integration.repositories?.some(
      repository =>
        typeof repository.full_name === 'string' &&
        repository.full_name.toLowerCase() === repositoryFullName.toLowerCase()
    )
  );
}

function ownerCondition(owner: Owner) {
  return owner.type === 'org'
    ? and(
        eq(platform_integrations.owned_by_organization_id, owner.id),
        isNull(platform_integrations.owned_by_user_id)
      )
    : and(
        eq(platform_integrations.owned_by_user_id, owner.id),
        isNull(platform_integrations.owned_by_organization_id)
      );
}

async function getHealthyGitHubIntegrations(
  owner: Owner,
  expectedIntegrationId?: string
): Promise<PlatformIntegration[]> {
  return db
    .select()
    .from(platform_integrations)
    .where(
      and(
        ownerCondition(owner),
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        eq(platform_integrations.integration_type, 'app'),
        isNotNull(platform_integrations.platform_installation_id),
        platformIntegrationHealthSql(),
        expectedIntegrationId ? eq(platform_integrations.id, expectedIntegrationId) : undefined
      )
    );
}

function toResolvedIntegration(
  integration: PlatformIntegration | undefined
): CliSessionGitHubIntegration | null {
  if (!integration?.platform_installation_id) return null;
  return {
    id: integration.id,
    platform_installation_id: integration.platform_installation_id,
    github_app_type: integration.github_app_type,
  };
}

export async function getPinnedCliSessionGitHubIntegration(input: {
  owner: Owner;
  repositoryFullName: string;
  integrationId: string;
}): Promise<CliSessionGitHubIntegration | null> {
  const integrations = await getHealthyGitHubIntegrations(input.owner, input.integrationId);
  return toResolvedIntegration(
    integrations.find(integration => repositoryMatches(integration, input.repositoryFullName))
  );
}

export async function resolveLegacyCliSessionGitHubIntegration(input: {
  owner: Owner;
  repositoryFullName: string;
}): Promise<CliSessionGitHubIntegration | null> {
  const integrations = await getHealthyGitHubIntegrations(input.owner);
  const matches = integrations.filter(integration =>
    repositoryMatches(integration, input.repositoryFullName)
  );
  return matches.length === 1 ? toResolvedIntegration(matches[0]) : null;
}
