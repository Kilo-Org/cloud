import type { PlatformIntegration } from '@kilocode/db/schema';
import type { InstallationToken } from '@/lib/integrations/core/types';
import {
  generateGitHubInstallationToken,
  type GitHubAppType,
} from '@/lib/integrations/platforms/github/adapter';

type InstallationTokenGenerator = (
  installationId: string,
  appType: GitHubAppType
) => Promise<InstallationToken>;

export async function generateAutoTriageInstallationToken(
  integration: Pick<PlatformIntegration, 'platform_installation_id' | 'github_app_type'>,
  generateToken: InstallationTokenGenerator = generateGitHubInstallationToken
) {
  if (!integration.platform_installation_id) {
    throw new Error('GitHub integration is missing an installation id.');
  }

  return generateToken(
    integration.platform_installation_id,
    integration.github_app_type ?? 'standard'
  );
}
