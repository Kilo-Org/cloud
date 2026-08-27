import 'server-only';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import { getGitHubIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';

export type CliSessionGitHubIntegration = Pick<
  PlatformIntegration,
  'id' | 'platform_installation_id' | 'github_app_type'
> & {
  platform_installation_id: string;
};

function toResolvedIntegration(
  integration: PlatformIntegration | undefined
): CliSessionGitHubIntegration | null {
  if (
    !integration?.platform_installation_id ||
    integration.integration_type !== 'app' ||
    !isPlatformIntegrationHealthy(integration)
  ) {
    return null;
  }
  return {
    id: integration.id,
    platform_installation_id: integration.platform_installation_id,
    github_app_type: integration.github_app_type,
  };
}

export async function getPinnedCliSessionGitHubIntegration(input: {
  owner: Owner;
  integrationId: string;
}): Promise<CliSessionGitHubIntegration | null> {
  const integration = await getGitHubIntegrationById(input.owner, input.integrationId);
  return toResolvedIntegration(integration ?? undefined);
}
