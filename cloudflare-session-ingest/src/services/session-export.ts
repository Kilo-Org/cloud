import { eq, and } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';

import type { Env } from '../env';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { withDORetry } from '@kilocode/worker-utils';

/**
 * Fetch the full session export payload from the SessionIngestDO.
 *
 * Verifies that the session exists in `cli_sessions_v2` and belongs to the
 * given user before reading the DO.
 *
 * @returns The raw JSON string from `SessionIngestDO.getAll()`, or `null`
 *          if the session does not exist or does not belong to the user.
 */
export async function getSessionExport(
  env: Env,
  sessionId: string,
  kiloUserId: string
): Promise<string | null> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);

  const rows = await db
    .select({ session_id: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
    )
    .limit(1);

  if (!rows[0]) {
    return null;
  }

  return withDORetry(
    () => getSessionIngestDO(env, { kiloUserId, sessionId }),
    stub => stub.getAll(),
    'SessionIngestDO.getAll'
  );
}
