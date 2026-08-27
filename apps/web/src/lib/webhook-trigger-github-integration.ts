import 'server-only';
import { db } from '@/lib/drizzle';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import { platform_integrations } from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';

const GITHUB_REPOSITORY_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export async function assertWebhookTriggerGitHubIntegrationAccess(input: {
  organizationId: string;
  githubIntegrationId: string;
  githubRepo: string;
}): Promise<void> {
  if (!GITHUB_REPOSITORY_PATTERN.test(input.githubRepo)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'GitHub repository must use owner/repo format',
    });
  }

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, input.githubIntegrationId),
        eq(platform_integrations.platform, 'github'),
        eq(platform_integrations.owned_by_organization_id, input.organizationId),
        isNull(platform_integrations.owned_by_user_id)
      )
    )
    .limit(1);

  const [repoOwner] = input.githubRepo.split('/');
  const integrationMatchesRepositoryOwner =
    !!integration?.platform_installation_id &&
    integration?.platform_account_login?.toLowerCase() === repoOwner?.toLowerCase();

  if (!isPlatformIntegrationHealthy(integration) || !integrationMatchesRepositoryOwner) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitHub integration not found or does not provide access to this repository',
    });
  }
}
