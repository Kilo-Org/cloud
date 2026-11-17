import * as z from 'zod';
import { ORGANIZATION_MODEL_AUDIENCES } from '@kilocode/app-shared/organizations';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import type { OpenRouterModelsResponse } from '@kilocode/web-shared/lib/organizations/organization-types';
import { getPreferredModels } from '@kilocode/web-shared/lib/ai-gateway/preferred-models';
import { getPersonalModelList } from '@kilocode/web-shared/lib/ai-gateway/handlers/models';
import { addAutoRoutingModels } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-models';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { requestCountryCode } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/country-deny-list';
import { loadAvailableModelsForOrganization } from '@kilocode/web-shared/routers/organizations/organization-available-models-procedure';
import { resolveOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';

export const modelsRouter = createTRPCRouter({
  preferred: baseProcedure.query(() => getPreferredModels()),

  list: baseProcedure.query(async ({ ctx }) => {
    const [response, preferredModels] = await Promise.all([
      getEnhancedOpenRouterModels({ countryCode: requestCountryCode(ctx.headersList) }),
      getPreferredModels(),
    ]);
    const preferredSet = new Set(preferredModels);

    return (response.data ?? []).map(model => ({
      id: model.id,
      name: model.name,
      supportsVision: model.architecture.input_modalities.includes('image'),
      isPreferred: preferredSet.has(model.id),
      variants: Object.keys(model.opencode?.variants ?? {}),
      ...(model.alias_target ? { alias_target: model.alias_target } : {}),
    }));
  }),

  /**
   * The list a model picker offers: the personal catalog, or an organization's
   * with the audience it names.
   *
   * The integration pages (Slack, Linear, Discord, GitHub) read their picker
   * from here instead of the REST routes under `/api`, because the app shell's
   * session cookie only covers `/app-shell`: its pages reach this procedure
   * through `/app-shell/api/trpc`, and the organization branch applies the same
   * membership gate `organizations.settings.listAvailableModels` does.
   */
  selectorList: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        audience: z.enum(ORGANIZATION_MODEL_AUDIENCES).default('member'),
      })
    )
    .output(z.custom<OpenRouterModelsResponse>())
    .query(async ({ ctx, input }) => {
      const organizationId = input.organizationId;
      if (!organizationId) {
        return getPersonalModelList({
          user: ctx.user,
          countryCode: requestCountryCode(ctx.headersList),
          fromDb: ctx.fromDb,
        });
      }

      // Same gate as `organizationMemberProcedure`, which admits members, Kilo
      // admins and parent-organization owners; the loader below trusts it.
      await resolveOrganizationAccess(ctx, organizationId);
      const result = await loadAvailableModelsForOrganization({
        userId: ctx.user.id,
        organizationId,
        audience: input.audience,
        headersList: ctx.headersList,
        fromDb: ctx.fromDb,
      });
      return { ...result, data: await addAutoRoutingModels(result.data) };
    }),
});
