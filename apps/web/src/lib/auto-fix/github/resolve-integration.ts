import type { AutoFixTicket, PlatformIntegration } from '@kilocode/db/schema';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import {
  getGitHubIntegrationById,
  resolveOrganizationGitHubIntegrationForRepository,
  type OrganizationGitHubIntegrationResolution,
} from '@/lib/integrations/db/platform-integrations';

export type AutoFixGitHubIntegrationResolution = OrganizationGitHubIntegrationResolution;

export async function resolveAutoFixGitHubIntegration(
  ticket: Pick<
    AutoFixTicket,
    'owned_by_organization_id' | 'owned_by_user_id' | 'platform_integration_id' | 'repo_full_name'
  >
): Promise<AutoFixGitHubIntegrationResolution> {
  if (ticket.owned_by_organization_id) {
    return resolveOrganizationGitHubIntegrationForRepository({
      organizationId: ticket.owned_by_organization_id,
      repositoryFullName: ticket.repo_full_name,
      expectedPlatformIntegrationId: ticket.platform_integration_id ?? undefined,
    });
  }

  if (!ticket.owned_by_user_id || !ticket.platform_integration_id) {
    return { success: false, reason: 'no_installation_found' };
  }

  const integration = await getGitHubIntegrationById(
    { type: 'user', id: ticket.owned_by_user_id },
    ticket.platform_integration_id
  );
  if (!isUsablePersonalIntegration(integration)) {
    return { success: false, reason: 'no_installation_found' };
  }

  return { success: true, integration };
}

function isUsablePersonalIntegration(
  integration: PlatformIntegration | null
): integration is PlatformIntegration {
  return Boolean(
    integration?.platform_installation_id && isPlatformIntegrationHealthy(integration)
  );
}
