import 'server-only';
import { db } from '@/lib/drizzle';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import { platform_integrations } from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

export async function assertWebhookTriggerGitHubIntegrationAccess(input: {
  organizationId: string;
  githubIntegrationId: string;
  githubRepo: string;
}): Promise<void> {
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

  const repositories = z
    .array(z.object({ full_name: z.string() }))
    .safeParse(integration?.repositories).data;
  const [repoOwner] = input.githubRepo.split('/');
  const repositoryIsAuthorized =
    integration?.platform_installation_id !== null &&
    integration?.platform_account_login?.toLowerCase() === repoOwner?.toLowerCase() &&
    (integration?.repository_access === 'all' ||
      (integration?.repository_access === 'selected' &&
        repositories?.some(
          repository => repository.full_name.toLowerCase() === input.githubRepo.toLowerCase()
        )));

  if (!isPlatformIntegrationHealthy(integration) || !repositoryIsAuthorized) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitHub integration not found or does not provide access to this repository',
    });
  }
}
