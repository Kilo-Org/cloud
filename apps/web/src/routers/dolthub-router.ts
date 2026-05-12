import 'server-only';
import { z } from 'zod';
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
        username: integration.platform_account_login,
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

  verifyToken: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    if (process.env.NODE_ENV === 'production') {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }

    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    const integration = await dolthubService.getInstallation(owner);

    if (!integration) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'DoltHub integration not found',
      });
    }

    const token = await dolthubService.getValidDoltHubToken(integration);
    if (!token) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'DoltHub access token is invalid or expired',
      });
    }

    const response = await fetch(
      'https://www.dolthub.com/api/v1alpha1/dolthub/profile?q=select+1',
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!response.ok) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: `DoltHub token verification failed: ${response.status} ${response.statusText}`,
      });
    }

    const data = await response.json();

    const DoltHubProfileResponseSchema = z.union([
      z.array(z.record(z.string(), z.unknown())),
      z.object({ rows: z.array(z.record(z.string(), z.unknown())).optional() }),
    ]);
    const parsed = DoltHubProfileResponseSchema.safeParse(data);
    const rows = parsed.success
      ? Array.isArray(parsed.data)
        ? parsed.data
        : (parsed.data.rows ?? [])
      : [];
    const sample = rows[0] ?? null;

    return { ok: true as const, sample };
  }),
});
