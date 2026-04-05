import { APP_URL } from '@/lib/constants';
import { db } from '@/lib/drizzle';
import type { Owner } from '@/lib/integrations/core/types';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Build the browser URL for a cloud agent session based on the owner type.
 * @param dbSessionId - The database UUID (session_id from cli_sessions table)
 * @param owner - The owner of the installation (user or org)
 */
export function buildSessionUrl(dbSessionId: string, owner: Owner): string {
  const basePath = owner.type === 'org' ? `/organizations/${owner.id}/cloud` : '/cloud';
  return `${APP_URL}${basePath}/chat?sessionId=${dbSessionId}`;
}

/**
 * Look up the database session UUID from the cloud agent session ID.
 * @param cloudAgentSessionId - The agent_xxx format ID from cloud agent
 * @returns The database UUID (session_id) or null if not found
 */
export async function getDbSessionIdFromCloudAgentId(
  cloudAgentSessionId: string
): Promise<string | null> {
  const [session] = await db
    .select({ session_id: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(eq(cli_sessions_v2.cloud_agent_session_id, cloudAgentSessionId))
    .limit(1);

  return session?.session_id ?? null;
}
