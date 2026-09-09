import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  GatewayConfigSchema,
  GatewayConfigInputSchema,
  DEFAULT_GATEWAY_CONFIG,
} from '@/lib/ai-gateway/gateway-config';
import type { GatewayConfig } from '@/lib/ai-gateway/gateway-config';
import { ai_gateway_config } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';

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

export const adminGatewayConfigRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    return readConfig();
  }),

  set: adminProcedure.input(GatewayConfigInputSchema).mutation(async ({ input, ctx }) => {
    const optOutModels = [
      ...new Set(
        input.vercel_routing_opt_out_models.map(model => model.trim().toLowerCase()).filter(Boolean)
      ),
    ];
    const config: GatewayConfig = {
      vercel_routing_percentage: input.vercel_routing_percentage,
      vercel_routing_percentage_free: input.vercel_routing_percentage_free,
      vercel_routing_opt_out_models: optOutModels,
      perplexity_routing_percentage: input.perplexity_routing_percentage,
      updated_at: new Date().toISOString(),
      updated_by: ctx.user.id,
      updated_by_email: ctx.user.google_user_email,
      note: input.note,
    };
    await db.insert(ai_gateway_config).values({ config }).onConflictDoUpdate({
      target: ai_gateway_config.id,
      set: { config },
    });
    return config;
  }),
});
