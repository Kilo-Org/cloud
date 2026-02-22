import 'server-only';
import { db } from '@/lib/drizzle';
import { platform_integrations } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import { getValidGitLabToken } from '@/lib/integrations/gitlab-service';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';

const LOG_PREFIX = '[gastown-git-credentials]';

type GitLabMetadata = {
  access_token?: string;
  refresh_token?: string;
  token_expires_at?: string;
  gitlab_instance_url?: string;
  auth_type?: string;
  client_id?: string;
  client_secret?: string;
};

/**
 * Resolved git credentials from a platform integration.
 * Suitable for writing into TownConfig.git_auth.
 */
export type ResolvedGitCredentials = {
  github_token?: string;
  gitlab_token?: string;
  gitlab_instance_url?: string;
};

/**
 * Resolve git credentials from a platform integration ID.
 *
 * For GitHub: generates an installation token (expires in ~1 hour).
 * For GitLab: returns a valid OAuth/PAT token (auto-refreshed if expired).
 *
 * Returns null if the integration is missing, inactive, or has no usable credentials.
 */
export async function resolveGitCredentialsFromIntegration(
  platformIntegrationId: string
): Promise<ResolvedGitCredentials | null> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, platformIntegrationId),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE)
      )
    )
    .limit(1);

  if (!integration) {
    console.warn(`${LOG_PREFIX} integration not found or inactive: id=${platformIntegrationId}`);
    return null;
  }

  if (integration.platform === 'github' && integration.platform_installation_id) {
    try {
      const tokenData = await generateGitHubInstallationToken(
        integration.platform_installation_id,
        integration.github_app_type ?? 'standard'
      );
      console.log(
        `${LOG_PREFIX} resolved GitHub token for integration=${platformIntegrationId} expires_at=${tokenData.expires_at}`
      );
      return { github_token: tokenData.token };
    } catch (err) {
      console.error(
        `${LOG_PREFIX} failed to generate GitHub installation token for integration=${platformIntegrationId}:`,
        err
      );
      return null;
    }
  }

  if (integration.platform === 'gitlab') {
    try {
      const token = await getValidGitLabToken(integration);
      const metadata = integration.metadata as GitLabMetadata | null;
      const instanceUrl = metadata?.gitlab_instance_url;

      console.log(
        `${LOG_PREFIX} resolved GitLab token for integration=${platformIntegrationId} instanceUrl=${instanceUrl ?? 'gitlab.com'}`
      );

      return {
        gitlab_token: token,
        // Only set gitlab_instance_url for self-hosted instances
        ...(instanceUrl &&
          instanceUrl !== 'https://gitlab.com' && { gitlab_instance_url: instanceUrl }),
      };
    } catch (err) {
      console.error(
        `${LOG_PREFIX} failed to get GitLab token for integration=${platformIntegrationId}:`,
        err
      );
      return null;
    }
  }

  console.warn(
    `${LOG_PREFIX} unsupported platform="${integration.platform}" for integration=${platformIntegrationId}`
  );
  return null;
}

/**
 * Refresh git credentials for a town's git_auth config.
 *
 * If a platformIntegrationId is provided, fetches a fresh token from the
 * integration and returns the updated git_auth fields. Otherwise returns null,
 * meaning the existing town config credentials should be used as-is.
 */
export async function refreshGitCredentials(
  platformIntegrationId: string | undefined | null
): Promise<ResolvedGitCredentials | null> {
  if (!platformIntegrationId) return null;
  return resolveGitCredentialsFromIntegration(platformIntegrationId);
}
