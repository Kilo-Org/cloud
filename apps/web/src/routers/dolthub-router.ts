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

/**
 * `{owner}/{repo}` upstream — same regex shape as `dolthubUpstream` on the
 * wasteland service input, kept in sync intentionally.
 */
const DOLTHUB_UPSTREAM_PATTERN = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/;

export const dolthubRouter = createTRPCRouter({
  getInstallation: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
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

  /**
   * Resolve the DoltHub username associated with the OAuth installation.
   * Returns the cached value when present, otherwise calls
   * `GET /api/v1alpha1/user` to fetch and cache it. Returns `null` when the
   * integration isn't installed or when the API call fails — callers
   * should fall back to asking the user to type their username.
   */
  resolveUsername: baseProcedure
    .input(optionalOrgInput)
    .query(async ({ ctx, input }): Promise<{ username: string } | null> => {
      const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
      const integration = await dolthubService.getInstallation(owner);
      if (!integration || integration.integration_status !== INTEGRATION_STATUS.ACTIVE) {
        return null;
      }

      return dolthubService.getDoltHubUser(integration);
    }),

  /**
   * Probes DoltHub to confirm `{owner}/{repo}` exists. Used by the
   * upstream picker to block submission of typo'd or non-existent
   * upstreams before the wasteland worker tries to fork or push.
   *
   * The verify call uses the OAuth-issued token when available so private
   * repos the OAuth user can read also resolve; without a token the probe
   * still works for public repos.
   */
  verifyUpstream: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
        upstream: z.string().regex(DOLTHUB_UPSTREAM_PATTERN, 'Must be in the format owner/repo'),
      })
    )
    .query(async ({ ctx, input }) => {
      const owner = await resolveAuthorizedOwner(ctx, input.organizationId);
      const integration = await dolthubService.getInstallation(owner);
      const token =
        integration && integration.integration_status === INTEGRATION_STATUS.ACTIVE
          ? await dolthubService.getValidDoltHubToken(integration)
          : null;

      try {
        return await dolthubService.verifyDoltHubUpstreamExists(input.upstream, token);
      } catch (err) {
        // Transport failures are explicitly NOT exists=false — surface
        // them so the UI can distinguish "doesn't exist" from "couldn't
        // tell" (which shouldn't block the user).
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : 'Failed to verify upstream',
        });
      }
    }),

  disconnect: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
    return dolthubService.uninstall(owner);
  }),
});
