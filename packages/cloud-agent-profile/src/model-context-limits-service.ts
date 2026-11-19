import { cloud_agent_user_settings } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { ProfileDatabase } from './types';
import {
  ModelContextLimitsSchema,
  normalizeModelContextLimits,
  type ModelContextLimits,
} from './model-context-limits';

export async function getModelContextLimits(
  db: ProfileDatabase,
  userId: string
): Promise<ModelContextLimits> {
  const [row] = await db
    .select({ limits: cloud_agent_user_settings.model_context_limits })
    .from(cloud_agent_user_settings)
    .where(eq(cloud_agent_user_settings.kilo_user_id, userId))
    .limit(1);
  return ModelContextLimitsSchema.parse(row?.limits ?? {});
}

export async function setModelContextLimits(
  db: ProfileDatabase,
  userId: string,
  limits: ModelContextLimits
): Promise<ModelContextLimits> {
  const normalized = normalizeModelContextLimits(ModelContextLimitsSchema.parse(limits));
  await db
    .insert(cloud_agent_user_settings)
    .values({ kilo_user_id: userId, model_context_limits: normalized })
    .onConflictDoUpdate({
      target: cloud_agent_user_settings.kilo_user_id,
      set: { model_context_limits: normalized },
    });
  return normalized;
}
