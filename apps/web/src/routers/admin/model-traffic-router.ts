import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { getModelTraffic, MODEL_TRAFFIC_RANGE_IDS } from '@/lib/ai-gateway/model-traffic';

export const adminModelTrafficRouter = createTRPCRouter({
  get: adminProcedure
    .input(z.object({ range: z.enum(MODEL_TRAFFIC_RANGE_IDS), excludeByok: z.boolean() }))
    .query(async ({ input }) => {
      try {
        return await getModelTraffic({ now: new Date(), ...input });
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to query model traffic from Analytics Engine',
          cause: error,
        });
      }
    }),
});
