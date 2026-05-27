import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { preferredModels } from '@/lib/ai-gateway/models';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { db } from '@/lib/drizzle';
import { gateway_custom_upstreams, organization_memberships } from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import * as z from 'zod';

const preferredSet = new Set(preferredModels);

export const modelsRouter = createTRPCRouter({
  list: baseProcedure
    .input(z.object({ organizationId: z.string().uuid().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const response = await getEnhancedOpenRouterModels();

      const gatewayModels = (response.data ?? []).map(model => ({
        id: model.id,
        name: model.name,
        supportsVision: model.architecture.input_modalities.includes('image'),
        isPreferred: preferredSet.has(model.id),
      }));

      if (input?.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }

      const orgMemberships = await db
        .select({ organization_id: organization_memberships.organization_id })
        .from(organization_memberships)
        .where(eq(organization_memberships.kilo_user_id, ctx.user.id));
      const orgIds = orgMemberships.map(m => m.organization_id);

      const upstreams = await db
        .select()
        .from(gateway_custom_upstreams)
        .where(
          and(
            eq(gateway_custom_upstreams.is_enabled, true),
            input?.organizationId
              ? eq(gateway_custom_upstreams.organization_id, input.organizationId)
              : orgIds.length > 0
                ? inArray(gateway_custom_upstreams.organization_id, orgIds)
                : eq(gateway_custom_upstreams.kilo_user_id, ctx.user.id)
          )
        );

      const customModels = upstreams.flatMap(upstream => {
        const mm = upstream.model_metadata as {
          models?: Array<{ id: string; name?: string; supportsVision?: boolean }>;
        };
        return (mm.models ?? []).map(model => ({
          id: `${upstream.provider_id}/${model.id}`,
          name: model.name ?? model.id,
          supportsVision: !!model.supportsVision,
          isPreferred: false,
        }));
      });

      return [...gatewayModels, ...customModels];
    }),
});
