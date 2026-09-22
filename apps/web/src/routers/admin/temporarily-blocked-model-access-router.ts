import { TRPCError } from '@trpc/server';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { redisClient } from '@/lib/redis';
import { TEMPORARILY_BLOCKED_MODEL_ACCESS_REDIS_KEY } from '@/lib/redis-keys';
import {
  getTemporarilyBlockedModelAccessConfig,
  TemporarilyBlockedModelAccessInputSchema,
  type TemporarilyBlockedModelAccessConfig,
} from '@/lib/ai-gateway/temporarily-blocked-model-access';

export const adminTemporarilyBlockedModelAccessRouter = createTRPCRouter({
  get: adminProcedure.query(() => getTemporarilyBlockedModelAccessConfig()),

  set: adminProcedure
    .input(TemporarilyBlockedModelAccessInputSchema)
    .mutation(async ({ input, ctx }) => {
      const organizationIds = [
        ...new Set(input.organization_ids.map(id => id.trim()).filter(Boolean)),
      ];
      const config: TemporarilyBlockedModelAccessConfig = {
        organization_ids: organizationIds,
        updated_at: new Date().toISOString(),
        updated_by: ctx.user.id,
        updated_by_email: ctx.user.google_user_email,
      };
      const written = await redisClient.set(
        TEMPORARILY_BLOCKED_MODEL_ACCESS_REDIS_KEY,
        JSON.stringify(config)
      );
      if (!written) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Redis is not configured; model access exceptions could not be saved.',
        });
      }
      return config;
    }),
});
