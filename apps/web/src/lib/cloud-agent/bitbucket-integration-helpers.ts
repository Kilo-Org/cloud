import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/drizzle';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  BitbucketOrganizationRepositoryListResultSchema,
  type BitbucketOrganizationRepositoryListResult,
} from '@/lib/integrations/platforms/bitbucket/oauth-integration';
import { listBitbucketRepositories } from '@/lib/integrations/platforms/bitbucket/repository-cache';
import { readCachedBitbucketWorkspaceAccessTokenRepositories } from '@/lib/integrations/platforms/bitbucket/workspace-access-token-repository-cache';
import { platform_integrations } from '@kilocode/db/schema';

async function findBitbucketIntegrationType(organizationId: string) {
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
  return integration?.integrationType ?? null;
}

export async function fetchBitbucketRepositoriesForOrganization(
  organizationId: string,
  kiloUserId: string
): Promise<BitbucketOrganizationRepositoryListResult> {
  const canonicalOrganizationId = z.uuid().safeParse(organizationId);
  if (!canonicalOrganizationId.success) return { status: 'invalid_request' };

  const integrationType = await findBitbucketIntegrationType(canonicalOrganizationId.data);
  if (integrationType === 'workspace_access_token') {
    return readCachedBitbucketWorkspaceAccessTokenRepositories({
      organizationId: canonicalOrganizationId.data,
    });
  }
  if (integrationType === 'oauth') {
    return listBitbucketRepositories({
      owner: { type: 'org', id: canonicalOrganizationId.data },
      kiloUserId,
    });
  }
  if (integrationType) return { status: 'reconnect_required' };
  return { status: 'not_connected' };
}

export { BitbucketOrganizationRepositoryListResultSchema };
export type { BitbucketOrganizationRepositoryListResult };
