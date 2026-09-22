import 'server-only';
import * as z from 'zod';
import { redisClient } from '@/lib/redis';
import { TEMPORARILY_BLOCKED_MODEL_ACCESS_REDIS_KEY } from '@/lib/redis-keys';

export const TemporarilyBlockedModelAccessConfigSchema = z.object({
  organization_ids: z.array(z.string().trim().min(1).max(255)).max(1000),
  updated_at: z.string().datetime().nullable(),
  updated_by: z.string().nullable(),
  updated_by_email: z.string().email().nullable(),
});

export type TemporarilyBlockedModelAccessConfig = z.infer<
  typeof TemporarilyBlockedModelAccessConfigSchema
>;

export const DEFAULT_TEMPORARILY_BLOCKED_MODEL_ACCESS_CONFIG: TemporarilyBlockedModelAccessConfig =
  {
    organization_ids: [],
    updated_at: null,
    updated_by: null,
    updated_by_email: null,
  };

export const TemporarilyBlockedModelAccessInputSchema = z.object({
  organization_ids: z.array(z.string().trim().min(1).max(255)).max(1000),
});

export async function getTemporarilyBlockedModelAccessConfig() {
  const raw = await redisClient.get<string>(TEMPORARILY_BLOCKED_MODEL_ACCESS_REDIS_KEY);
  if (!raw) return DEFAULT_TEMPORARILY_BLOCKED_MODEL_ACCESS_CONFIG;
  return TemporarilyBlockedModelAccessConfigSchema.parse(JSON.parse(raw));
}

export async function isTemporarilyBlockedModelAllowedForOrganization(
  organizationId: string | undefined
) {
  if (!organizationId) return false;

  try {
    const config = await getTemporarilyBlockedModelAccessConfig();
    return config.organization_ids.includes(organizationId);
  } catch {
    return false;
  }
}
