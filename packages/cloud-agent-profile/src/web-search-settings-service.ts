import { cloud_agent_user_settings } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import type { ProfileDatabase } from './types';

/**
 * Mirrors `services/cloud-agent-next/src/shared/web-search-provider.ts`
 * `webSearchPreferenceSchema`. The profile package must not import from the
 * service, so `web-search-provider.parity.test.ts` guards the two unions.
 */
export const webSearchPreferenceSchema = z.union([
  z.literal('default'),
  z.enum(['exa', 'firecrawl', 'parallel', 'tavily', 'tinyfish']),
  z.literal('off'),
]);
export type WebSearchPreference = z.infer<typeof webSearchPreferenceSchema>;

export async function getWebSearchPreference(
  db: ProfileDatabase,
  userId: string
): Promise<WebSearchPreference> {
  const [row] = await db
    .select({
      enabled: cloud_agent_user_settings.web_search_enabled,
      provider: cloud_agent_user_settings.web_search_provider,
    })
    .from(cloud_agent_user_settings)
    .where(eq(cloud_agent_user_settings.kilo_user_id, userId))
    .limit(1);
  const stored = row?.enabled === false ? 'off' : (row?.provider ?? 'default');
  const parsed = webSearchPreferenceSchema.safeParse(stored);
  return parsed.success ? parsed.data : 'default';
}

export async function setWebSearchPreference(
  db: ProfileDatabase,
  userId: string,
  preference: WebSearchPreference
): Promise<void> {
  const settings = {
    web_search_enabled: preference !== 'off',
    web_search_provider: preference === 'off' || preference === 'default' ? null : preference,
  };
  await db
    .insert(cloud_agent_user_settings)
    .values({ kilo_user_id: userId, ...settings })
    .onConflictDoUpdate({
      target: cloud_agent_user_settings.kilo_user_id,
      set: settings,
    });
}
