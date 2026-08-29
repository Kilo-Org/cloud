import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/drizzle';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  withRepositoryReadDeadline,
  type RepositoryReadOptions,
} from '@/lib/integrations/core/repository-read-limits';
import {
  BitbucketOrganizationRepositoryListResultSchema,
  type BitbucketOrganizationRepositoryListResult,
} from '@/lib/integrations/platforms/bitbucket/oauth-integration';
import { listBitbucketRepositories } from '@/lib/integrations/platforms/bitbucket/repository-cache';
import {
  readCachedBitbucketWorkspaceAccessTokenRepositories,
  refreshBitbucketWorkspaceAccessTokenRepositoriesForMember,
} from '@/lib/integrations/platforms/bitbucket/workspace-access-token-repository-cache';
import { platform_integrations } from '@kilocode/db/schema';

async function findBitbucketIntegration(organizationId: string) {
  const [integration] = await db
    .select({ integrationType: platform_integrations.integration_type })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.owned_by_organization_id, organizationId),
        isNull(platform_integrations.owned_by_user_id),
        eq(platform_integrations.platform, PLATFORM.BITBUCKET)
      )
    )
    .limit(1);
  return integration ?? null;
}

export async function fetchBitbucketRepositoriesForOrganization(
  organizationId: string,
  kiloUserId: string,
  forceRefresh = false,
  options?: RepositoryReadOptions
): Promise<BitbucketOrganizationRepositoryListResult> {
  const canonicalOrganizationId = z.uuid().safeParse(organizationId);
  if (!canonicalOrganizationId.success) return { status: 'invalid_request' };

  let integrationFound = false;
  try {
    const result = await withRepositoryReadDeadline<BitbucketOrganizationRepositoryListResult>(
      options,
      async signal => {
        const readOptions = options?.bounded ? { bounded: true, signal } : undefined;
        const integration = await findBitbucketIntegration(canonicalOrganizationId.data);
        signal?.throwIfAborted();
        if (!integration) return { status: 'not_connected' };
        integrationFound = true;
        const integrationType = integration.integrationType;
        if (integrationType === 'workspace_access_token') {
          if (!forceRefresh) {
            const cached = await readCachedBitbucketWorkspaceAccessTokenRepositories({
              organizationId: canonicalOrganizationId.data,
              readOptions,
            });
            if (!readOptions || cached.status !== 'temporarily_unavailable') return cached;
          }
          signal?.throwIfAborted();
          return refreshBitbucketWorkspaceAccessTokenRepositoriesForMember({
            organizationId: canonicalOrganizationId.data,
            kiloUserId,
            readOptions,
          });
        }
        if (integrationType === 'oauth') {
          return listBitbucketRepositories({
            owner: { type: 'org', id: canonicalOrganizationId.data },
            kiloUserId,
            forceRefresh,
            readOptions,
          });
        }
        if (integrationType || readOptions) return { status: 'reconnect_required' };
        return { status: 'not_connected' };
      }
    );
    return options?.bounded && integrationFound && result.status === 'not_connected'
      ? { status: 'temporarily_unavailable' }
      : result;
  } catch (error) {
    if (!options?.bounded) throw error;
    return { status: 'temporarily_unavailable' };
  }
}

export { BitbucketOrganizationRepositoryListResultSchema };
export type { BitbucketOrganizationRepositoryListResult };
