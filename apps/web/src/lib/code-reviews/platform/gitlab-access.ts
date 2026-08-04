import type { PlatformIntegration } from '@kilocode/db/schema';

import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import {
  getValidGitLabProjectAccessToken,
  getValidGitLabToken,
} from '@/lib/integrations/gitlab-service';

/**
 * Resolves a GitLab access token for a review's project.
 * Uses the exact project credential when a project ID is present.
 */
export async function resolveGitLabAccessToken(
  integration: PlatformIntegration,
  projectId: number | null
): Promise<string> {
  let userId: string;
  let organizationId: string | undefined;
  if (integration.owned_by_organization_id) {
    organizationId = integration.owned_by_organization_id;
    const botUserId = await getBotUserId(organizationId, 'code-review');
    if (!botUserId) throw new Error('GitLab organization has no configured acting user');
    userId = botUserId;
  } else if (integration.owned_by_user_id) {
    userId = integration.owned_by_user_id;
  } else {
    throw new Error('GitLab integration has no owner');
  }
  const actor = { userId, ...(organizationId ? { organizationId } : {}) };
  return projectId
    ? await getValidGitLabProjectAccessToken(integration, projectId, actor)
    : await getValidGitLabToken(integration, actor);
}

/**
 * Extracts the GitLab instance URL from an integration's metadata.
 */
export function getGitLabInstanceUrl(integration: PlatformIntegration): string {
  const metadata = integration.metadata as {
    gitlab_instance_url?: string;
  } | null;
  return metadata?.gitlab_instance_url || 'https://gitlab.com';
}
