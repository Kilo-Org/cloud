import { cloud_agent_builtin_agent_settings } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { ProfileDatabase } from './types';
import {
  BuiltinAgentSettingsSchema,
  normalizeBuiltinAgentSettings,
  type BuiltinAgentSettings,
} from './builtin-agents';

export async function getBuiltinAgentSettings(
  db: ProfileDatabase,
  userId: string
): Promise<BuiltinAgentSettings> {
  const [row] = await db
    .select({ agents: cloud_agent_builtin_agent_settings.agents })
    .from(cloud_agent_builtin_agent_settings)
    .where(eq(cloud_agent_builtin_agent_settings.user_id, userId))
    .limit(1);
  return BuiltinAgentSettingsSchema.parse(row?.agents ?? {});
}

export async function setBuiltinAgentSettings(
  db: ProfileDatabase,
  userId: string,
  settings: BuiltinAgentSettings
): Promise<BuiltinAgentSettings> {
  const agents = normalizeBuiltinAgentSettings(BuiltinAgentSettingsSchema.parse(settings));
  await db
    .insert(cloud_agent_builtin_agent_settings)
    .values({ user_id: userId, agents })
    .onConflictDoUpdate({
      target: cloud_agent_builtin_agent_settings.user_id,
      set: { agents },
    });
  return agents;
}

export async function clearBuiltinAgentSettings(
  db: ProfileDatabase,
  userId: string
): Promise<void> {
  await db
    .delete(cloud_agent_builtin_agent_settings)
    .where(eq(cloud_agent_builtin_agent_settings.user_id, userId));
}
