import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { redisGet, redisSet } from '@/lib/redis';
import {
  VERCEL_ROUTING_REDIS_KEY,
  GatewayConfigSchema,
  GatewayConfigInputSchema,
  DEFAULT_GATEWAY_CONFIG,
} from '@/lib/gateway-config';
import type { GatewayConfig } from '@/lib/gateway-config';
import { TRPCError } from '@trpc/server';

async function readConfig(): Promise<GatewayConfig> {
  try {
    const raw = await redisGet(VERCEL_ROUTING_REDIS_KEY);
    if (!raw) return DEFAULT_GATEWAY_CONFIG;
    return GatewayConfigSchema.parse(JSON.parse(raw));
  } catch {
    return DEFAULT_GATEWAY_CONFIG;
  }
}

export const adminGatewayConfigRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    return readConfig();
  }),

  set: adminProcedure.input(GatewayConfigInputSchema).mutation(async ({ input, ctx }) => {
    const config: GatewayConfig = {
      vercel_routing_percentage: input.vercel_routing_percentage,
      updated_at: new Date().toISOString(),
      updated_by: ctx.user.id,
      updated_by_email: ctx.user.google_user_email,
    };
    const written = await redisSet(VERCEL_ROUTING_REDIS_KEY, JSON.stringify(config));
    if (!written) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Redis is not configured — cannot save routing override',
      });
    }
    return config;
  }),
});
