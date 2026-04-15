import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { gateway_config } from '@kilocode/db/schema';
import * as z from 'zod';

const SINGLETON_ID = 1;

export const adminGatewayConfigRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    const rows = await db.select().from(gateway_config).limit(1);
    const row = rows.at(0);
    return {
      vercel_routing_percentage: row?.vercel_routing_percentage ?? null,
      updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null,
    };
  }),

  set: adminProcedure
    .input(
      z.object({
        vercel_routing_percentage: z.number().int().min(0).max(100).nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const [row] = await db
        .insert(gateway_config)
        .values({
          id: SINGLETON_ID,
          vercel_routing_percentage: input.vercel_routing_percentage,
          updated_by: ctx.user.id,
        })
        .onConflictDoUpdate({
          target: gateway_config.id,
          set: {
            vercel_routing_percentage: input.vercel_routing_percentage,
            updated_at: new Date().toISOString(),
            updated_by: ctx.user.id,
          },
        })
        .returning();
      return row;
    }),
});
