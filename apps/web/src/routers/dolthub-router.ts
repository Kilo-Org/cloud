import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import {
  resolveOwner,
  resolveAuthorizedOwner,
  optionalOrgInput,
} from '@/lib/integrations/resolve-owner';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import * as dolthubService from '@/lib/integrations/dolthub-service';

export const dolthubRouter = createTRPCRouter({
  getInstallation: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (process.env.NODE_ENV === 'production') {
      return { installed: false, installation: null };
    }

    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    const integration = await dolthubService.getInstallation(owner);

    if (!integration) {
      return { installed: false, installation: null };
    }

    return {
      installed: integration.integration_status === 'active',
      installation: {
        status: integration.integration_status,
        installedAt: integration.installed_at,
        scopes: integration.scopes,
      },
    };
  }),

  disconnect: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    if (process.env.NODE_ENV === 'production') {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }

    const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
    return dolthubService.uninstall(owner);
  }),
});
