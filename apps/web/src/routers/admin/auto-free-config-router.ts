import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  AUTO_FREE_FALLBACK_CONFIG,
  getIneligibleAutoFreeModelIds,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config, custom_llm2 } from '@kilocode/db/schema';
import { parseCustomLlmRows } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { AutoFreeConfigSchema } from '@kilocode/db/schema-types';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import * as z from 'zod';

const SetAutoFreeConfigSchema = z.object({
  config: AutoFreeConfigSchema.nullable(),
});

export const adminAutoFreeConfigRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    const [row] = await db
      .select({ auto_free: ai_gateway_config.auto_free })
      .from(ai_gateway_config)
      .where(eq(ai_gateway_config.id, 1))
      .limit(1);
    return { config: row?.auto_free ?? null, fallback: AUTO_FREE_FALLBACK_CONFIG };
  }),

  set: adminProcedure.input(SetAutoFreeConfigSchema).mutation(async ({ input }) => {
    // Read the primary, not the cached catalog, so a custom LLM saved moments ago counts.
    const ineligibleModelIds = input.config
      ? getIneligibleAutoFreeModelIds(
          input.config,
          parseCustomLlmRows(await db.select().from(custom_llm2))
        )
      : [];
    if (ineligibleModelIds.length > 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Not eligible for kilo-auto/free (must be a free model that uses the default AI SDK provider, or a public custom LLM that serves Chat Completions): ${ineligibleModelIds.join(', ')}`,
      });
    }

    await db
      .insert(ai_gateway_config)
      .values({ auto_free: input.config })
      .onConflictDoUpdate({
        target: ai_gateway_config.id,
        set: { auto_free: input.config },
      });
    return { config: input.config };
  }),
});
