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
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';
import * as dolthubService from '@/lib/integrations/dolthub-service';

/**
 * DoltHub usernames are lowercase alphanumerics + hyphens. Validate at the
 * tRPC boundary so we reject typos like spaces or slashes before they get
 * cached into integration metadata and surface again on the next connect.
 */
const DOLTHUB_USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

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

  /**
   * Returns the OAuth-issued DoltHub access token plus the cached username
   * (if any), for the caller to forward into the Wasteland worker's
   * `storeCredential` mutation.
   *
   * The token is a bearer secret — only return it to the authenticated
   * owner of an *active* integration. Mirrors the `installed` check used
   * by `getInstallation` so a stale, non-active row never leaks its token.
   * The wasteland worker stores its own encrypted copy; the browser never
   * persists this token.
   */
  getInstallationCredentials: baseProcedure
    .input(optionalOrgInput)
    .query(async ({ ctx, input }) => {
      if (process.env.NODE_ENV === 'production') {
        return null;
      }

      const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
      const integration = await dolthubService.getInstallation(owner);
      if (!integration || integration.integration_status !== INTEGRATION_STATUS.ACTIVE) {
        return null;
      }

      const token = await dolthubService.getValidDoltHubToken(integration);
      if (!token) return null;

      return {
        token,
        dolthubUsername: dolthubService.getCachedDoltHubUsername(integration),
      };
    }),

  /**
   * Persist the DoltHub username the user just confirmed during a
   * wasteland connect, so subsequent connects can skip the prompt.
   * No-op when the integration isn't installed.
   */
  rememberUsername: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
        username: z
          .string()
          .min(1)
          .max(64)
          .regex(DOLTHUB_USERNAME_PATTERN, 'Invalid DoltHub username'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (process.env.NODE_ENV === 'production') {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      const owner = await resolveAuthorizedOwner(ctx, input.organizationId);
      const integration = await dolthubService.getInstallation(owner);
      if (!integration) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'DoltHub integration is not installed',
        });
      }

      await dolthubService.rememberDoltHubUsername(integration, input.username);
      return { success: true };
    }),

  disconnect: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    if (process.env.NODE_ENV === 'production') {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }

    const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
    return dolthubService.uninstall(owner);
  }),
});
