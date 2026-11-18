import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { mapResolvedModelIdToVercelWithoutOverrides } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { ai_gateway_config } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

export const adminVercelModelIdOverridesRouter = createTRPCRouter({
  list: adminProcedure.query(async () => {
    const [row] = await db
      .select({ config: ai_gateway_config.vercel_model_id_overrides })
      .from(ai_gateway_config)
      .where(eq(ai_gateway_config.id, 1))
      .limit(1);
    const overrides = row?.config?.overrides ?? [];
    return {
      items: overrides
        .map(override => ({
          ...override,
          builtin_vercel_model_id: mapResolvedModelIdToVercelWithoutOverrides(
            override.openrouter_model_id
          ),
        }))
        .sort((a, b) => a.openrouter_model_id.localeCompare(b.openrouter_model_id)),
    };
  }),
});
