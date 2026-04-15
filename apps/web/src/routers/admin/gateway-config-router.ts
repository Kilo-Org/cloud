import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { redisGet, redisSet } from '@/lib/redis';
import * as z from 'zod';

const REDIS_KEY = 'gateway:vercel-routing-percentage';

const StoredConfigSchema = z.object({
  vercel_routing_percentage: z.number().int().min(0).max(100).nullable(),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_by_email: z.string().nullable(),
});

type StoredConfig = z.infer<typeof StoredConfigSchema>;

const DEFAULT_CONFIG: StoredConfig = {
  vercel_routing_percentage: null,
  updated_at: null,
  updated_by: null,
  updated_by_email: null,
};

async function readConfig(): Promise<StoredConfig> {
  const raw = await redisGet(REDIS_KEY);
  if (!raw) return DEFAULT_CONFIG;
  try {
    return StoredConfigSchema.parse(JSON.parse(raw));
  } catch {
    return DEFAULT_CONFIG;
  }
}

export const VERCEL_ROUTING_REDIS_KEY = REDIS_KEY;

export const adminGatewayConfigRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    return readConfig();
  }),

  set: adminProcedure
    .input(
      z.object({
        vercel_routing_percentage: z.number().int().min(0).max(100).nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const config: StoredConfig = {
        vercel_routing_percentage: input.vercel_routing_percentage,
        updated_at: new Date().toISOString(),
        updated_by: ctx.user.id,
        updated_by_email: ctx.user.google_user_email,
      };
      await redisSet(REDIS_KEY, JSON.stringify(config));
      return config;
    }),
});
