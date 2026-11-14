import { cloud_agent_user_settings } from '@kilocode/db/schema';
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
    .select({ agents: cloud_agent_user_settings.builtin_agents })
    .from(cloud_agent_user_settings)
    .where(eq(cloud_agent_user_settings.kilo_user_id, userId))
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
    .insert(cloud_agent_user_settings)
    .values({ kilo_user_id: userId, builtin_agents: agents })
    .onConflictDoUpdate({
      target: cloud_agent_user_settings.kilo_user_id,
      set: { builtin_agents: agents },
    });
  return agents;
}
