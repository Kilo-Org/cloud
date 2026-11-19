import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  ORGANIZATION_MODEL_AUDIENCES,
  type OrganizationModelAudience,
} from '@kilocode/app-shared/organizations';
import type { OpenRouterModelsResponse } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/catalog-schemas';
import { getAvailableModelsForOrganization } from '@kilocode/web-shared/lib/organizations/organization-models';
import { addCustomRouterModels } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-models';
import { listUsableCustomRouters } from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { requestCountryCode } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/country-deny-list';
import type { ModelStatsLoadClient } from '@kilocode/web-shared/lib/model-stats/model-stats-cache';
import {
  OrganizationIdInputSchema,
  organizationMemberProcedure,
} from '@kilocode/web-shared/routers/organizations/utils';

/**
 * The model list an organization member may choose from, with the organization's
 * usable custom routers folded in. The caller has already been admitted by the
 * organization gate: this function does not check membership itself, so every
 * surface that calls it owes the same check before (the procedure's middleware
 * on the web router, `resolveOrganizationAccess` on `models.selectorList`).
 */
export async function loadAvailableModelsForOrganization(params: {
  userId: string;
  organizationId: string;
  audience: OrganizationModelAudience;
  headersList?: Headers;
  fromDb?: ModelStatsLoadClient;
}): Promise<OpenRouterModelsResponse> {
  const { userId, organizationId, audience, headersList, fromDb } = params;

  const result = await getAvailableModelsForOrganization(
    organizationId,
    {
      type: 'member',
      kiloUserId: userId,
      // `ensureOrganizationAccess` also admits Kilo admins and parent-organization
      // owners, who hold no membership row and belong to no group; they resolve
      // against organization-level policy instead of being rejected.
      allowNonMember: true,
    },
    audience,
    {
      countryCode: requestCountryCode(headersList),
      fromDb,
    }
  );
  if (!result) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Organization not found',
    });
  }
  const routers = await listUsableCustomRouters({
    userId,
    organizationId,
  }).catch(error => {
    captureException(error, {
      tags: { endpoint: 'organizations/models' },
      extra: { action: 'listing_custom_routers', organizationId },
    });
    return [];
  });
  return {
    ...result,
    data: addCustomRouterModels(
      result.data,
      routers.filter(router => router.ownerType === 'org' && router.ownerId === organizationId)
    ),
  };
}

// Its own module so the gateway's organization model routes can mount this
// procedure without the rest of the settings router, and so `models.selectorList`
// can answer the same list over the shell's tRPC entry point.
export const listAvailableModelsProcedure = organizationMemberProcedure
  .input(
    OrganizationIdInputSchema.extend({
      audience: z.enum(ORGANIZATION_MODEL_AUDIENCES).default('member'),
    })
  )
  .output(z.custom<OpenRouterModelsResponse>())
  .query(async ({ input, ctx }) =>
    loadAvailableModelsForOrganization({
      userId: ctx.user.id,
      organizationId: input.organizationId,
      audience: input.audience,
      headersList: ctx.headersList,
      fromDb: ctx.fromDb,
    })
  );
