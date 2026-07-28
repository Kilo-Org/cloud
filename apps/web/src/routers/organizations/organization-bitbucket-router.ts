import 'server-only';

import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/drizzle';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  disconnectBitbucketOAuthIntegration,
  getBitbucketOAuthIntegrationStatus,
  refreshBitbucketOAuthRepositories,
  selectBitbucketOAuthWorkspace,
} from '@/lib/integrations/platforms/bitbucket/oauth-integration';
import {
  BitbucketWorkspaceAccessTokenRepositoryCacheAuthorizationError,
  getBitbucketWorkspaceAccessTokenStatus,
  refreshBitbucketWorkspaceAccessTokenRepositories,
} from '@/lib/integrations/platforms/bitbucket/workspace-access-token-repository-cache';
import {
  BitbucketWorkspaceAccessTokenCredentialError,
  connectBitbucketWorkspaceAccessToken,
  disconnectBitbucketWorkspaceAccessToken,
  rotateBitbucketWorkspaceAccessToken,
} from '@/lib/integrations/platforms/bitbucket/workspace-access-token-credentials';
import { BitbucketWorkspaceAccessTokenError } from '@/lib/integrations/platforms/bitbucket/workspace-access-token-adapter';
import { cleanupBitbucketCodeReviewerForIntegration } from '@/lib/integrations/platforms/bitbucket/code-review-cleanup';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  ensureOrganizationAccess,
  organizationBillingProcedure,
} from '@/routers/organizations/utils';
import { platform_integrations } from '@kilocode/db/schema';

const AccessTokenSchema = z.string().trim().min(1).max(8_192);
const IntegrationIdSchema = z.uuid();

const ConnectInputSchema = OrganizationIdInputSchema.extend({
  accessToken: AccessTokenSchema,
}).strict();

const ReplaceTokenInputSchema = OrganizationIdInputSchema.extend({
  integrationId: IntegrationIdSchema,
  accessToken: AccessTokenSchema,
}).strict();

const ExistingIntegrationInputSchema = OrganizationIdInputSchema.extend({
  integrationId: IntegrationIdSchema,
}).strict();

const SelectWorkspaceInputSchema = OrganizationIdInputSchema.extend({
  workspaceUuid: z.string().min(1),
  workspaceSlug: z.string().min(1),
}).strict();

type OrganizationBitbucketIntegration = {
  integrationType: 'workspace_access_token' | 'oauth';
  workspace: { uuid: string; slug: string } | null;
};

async function findOrganizationBitbucketIntegration(input: {
  organizationId: string;
  integrationId: string;
}): Promise<OrganizationBitbucketIntegration> {
  const [integration] = await db
    .select({
      integrationType: platform_integrations.integration_type,
      workspaceUuid: platform_integrations.platform_account_id,
      workspaceSlug: platform_integrations.platform_account_login,
    })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, input.integrationId),
        eq(platform_integrations.owned_by_organization_id, input.organizationId),
        eq(platform_integrations.platform, PLATFORM.BITBUCKET)
      )
    )
    .limit(1);

  if (
    integration?.integrationType !== 'workspace_access_token' &&
    integration?.integrationType !== 'oauth'
  ) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'The Bitbucket integration was not found' });
  }
  return {
    integrationType: integration.integrationType,
    workspace:
      integration.integrationType === 'workspace_access_token' &&
      integration.workspaceUuid &&
      integration.workspaceSlug
        ? { uuid: integration.workspaceUuid, slug: integration.workspaceSlug }
        : null,
  };
}

function rethrowBitbucketMutationError(error: unknown): never {
  if (error instanceof BitbucketWorkspaceAccessTokenRepositoryCacheAuthorizationError) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: error.message });
  }

  if (error instanceof BitbucketWorkspaceAccessTokenCredentialError) {
    switch (error.code) {
      case 'unauthorized':
        throw new TRPCError({ code: 'UNAUTHORIZED', message: error.message });
      case 'organization_not_found':
      case 'not_connected':
        throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
      case 'credential_conflict':
        throw new TRPCError({ code: 'CONFLICT', message: error.message });
      case 'invalid_organization_id':
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
      case 'encryption_failed':
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
    }
  }

  if (error instanceof BitbucketWorkspaceAccessTokenError) {
    switch (error.code) {
      case 'permission_denied':
      case 'insufficient_scopes':
        throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
      case 'rate_limited':
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: error.message });
      case 'request_timeout':
        throw new TRPCError({ code: 'TIMEOUT', message: error.message });
      case 'provider_unavailable':
      case 'request_failed':
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      default:
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
    }
  }

  throw error;
}

export const organizationBitbucketRouter = createTRPCRouter({
  getStatus: baseProcedure.input(OrganizationIdInputSchema).query(async ({ ctx, input }) => {
    const role = await ensureOrganizationAccess(ctx, input.organizationId);
    const canManage = role === 'owner' || role === 'billing_manager';
    const workspaceAccessTokenStatus = await getBitbucketWorkspaceAccessTokenStatus(
      input.organizationId
    );
    if (workspaceAccessTokenStatus.integrationId) {
      return {
        ...workspaceAccessTokenStatus,
        canManage,
      };
    }

    const oauthStatus = await getBitbucketOAuthIntegrationStatus(
      { type: 'org', id: input.organizationId },
      canManage
    );
    return oauthStatus ?? { ...workspaceAccessTokenStatus, canManage };
  }),

  connect: organizationBillingProcedure
    .input(ConnectInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await connectBitbucketWorkspaceAccessToken({
          organizationId: input.organizationId,
          actorUserId: ctx.user.id,
          accessToken: input.accessToken,
        });
      } catch (error) {
        rethrowBitbucketMutationError(error);
      }
    }),

  replaceToken: organizationBillingProcedure
    .input(ReplaceTokenInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await rotateBitbucketWorkspaceAccessToken({
          organizationId: input.organizationId,
          actorUserId: ctx.user.id,
          integrationId: input.integrationId,
          accessToken: input.accessToken,
        });
      } catch (error) {
        rethrowBitbucketMutationError(error);
      }
    }),

  selectWorkspace: organizationBillingProcedure
    .input(SelectWorkspaceInputSchema)
    .mutation(async ({ ctx, input }) => {
      return selectBitbucketOAuthWorkspace({
        owner: { type: 'org', id: input.organizationId },
        kiloUserId: ctx.user.id,
        workspaceUuid: input.workspaceUuid,
        workspaceSlug: input.workspaceSlug,
      });
    }),

  refreshRepositories: organizationBillingProcedure
    .input(ExistingIntegrationInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const integration = await findOrganizationBitbucketIntegration(input);
        if (integration.integrationType === 'oauth') {
          return await refreshBitbucketOAuthRepositories({
            owner: { type: 'org', id: input.organizationId },
            kiloUserId: ctx.user.id,
            expectedIntegrationId: input.integrationId,
          });
        }

        return await refreshBitbucketWorkspaceAccessTokenRepositories({
          organizationId: input.organizationId,
          kiloUserId: ctx.user.id,
          expectedIntegrationId: input.integrationId,
        });
      } catch (error) {
        rethrowBitbucketMutationError(error);
      }
    }),

  disconnect: organizationBillingProcedure
    .input(ExistingIntegrationInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const integration = await findOrganizationBitbucketIntegration(input);
        if (integration.integrationType === 'oauth') {
          const disconnected = await disconnectBitbucketOAuthIntegration({
            owner: { type: 'org', id: input.organizationId },
            integrationId: input.integrationId,
          });
          return { integrationId: disconnected.integrationId };
        }

        await cleanupBitbucketCodeReviewerForIntegration({
          organizationId: input.organizationId,
          currentManagerId: ctx.user.id,
          integrationId: input.integrationId,
          workspace: integration.workspace,
        });
        return await disconnectBitbucketWorkspaceAccessToken({
          organizationId: input.organizationId,
          actorUserId: ctx.user.id,
          integrationId: input.integrationId,
        });
      } catch (error) {
        rethrowBitbucketMutationError(error);
      }
    }),
});
