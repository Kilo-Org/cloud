import 'server-only';
import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
import { optionalOrgInput, resolveOwner } from '@/lib/integrations/resolve-owner';
import { summarizePlatformIntegrationsForSetupStatus } from '@/lib/integrations/platform-integration-setup-status';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

export const platformIntegrationsRouter = createTRPCRouter({
  listSetupStatus: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }

    const owner = resolveOwner(ctx, input?.organizationId);
    const integrations = await getAllIntegrationsForOwner(owner);
    const visibleIntegrations = integrations.filter(integration => {
      if (integration.platform !== PLATFORM.BITBUCKET) return true;
      return (
        owner.type === 'org' &&
        (integration.integration_type === 'workspace_access_token' ||
          integration.integration_type === 'oauth')
      );
    });
    return summarizePlatformIntegrationsForSetupStatus(visibleIntegrations);
  }),
});
