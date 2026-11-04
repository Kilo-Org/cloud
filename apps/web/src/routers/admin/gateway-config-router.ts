import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  GatewayConfigSchema,
  GatewayConfigInputSchema,
  DEFAULT_GATEWAY_CONFIG,
  OrganizationFeaturesInputSchema,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import type {
  GatewayConfig,
  OrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { readOrganizationFeatures } from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { ai_gateway_config } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { eq, sql } from 'drizzle-orm';

async function readConfig(): Promise<GatewayConfig> {
  try {
    const [row] = await db
      .select({ config: ai_gateway_config.config })
      .from(ai_gateway_config)
      .where(eq(ai_gateway_config.id, 1))
      .limit(1);
    if (!row) return DEFAULT_GATEWAY_CONFIG;
    return GatewayConfigSchema.parse(row.config);
  } catch {
    return DEFAULT_GATEWAY_CONFIG;
  }
}

/** Each admin form owns some keys of the stored configuration, so a save must keep the others. */
async function mergeIntoConfig(values: Record<string, unknown>): Promise<void> {
  await db
    .insert(ai_gateway_config)
    .values({ config: values })
    .onConflictDoUpdate({
      target: ai_gateway_config.id,
      set: { config: sql`${ai_gateway_config.config} || ${JSON.stringify(values)}::jsonb` },
    });
}

export const adminGatewayConfigRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    return readConfig();
  }),

  set: adminProcedure.input(GatewayConfigInputSchema).mutation(async ({ input, ctx }) => {
    const config: GatewayConfig = {
      vercel_routing_enabled: input.vercel_routing_enabled,
      vercel_routing_opt_out_models: input.vercel_routing_opt_out_models,
      updated_at: new Date().toISOString(),
      updated_by: ctx.user.id,
      updated_by_email: ctx.user.google_user_email,
      note: input.note,
    };
    await mergeIntoConfig(config);
    return config;
  }),

  getOrganizationFeatures: adminProcedure.query(async () => {
    return readOrganizationFeatures(db);
  }),

  setOrganizationFeatures: adminProcedure
    .input(OrganizationFeaturesInputSchema)
    .mutation(async ({ input }) => {
      const organization_features: OrganizationFeatures = input;
      await mergeIntoConfig({ organization_features });
      return organization_features;
    }),
});
