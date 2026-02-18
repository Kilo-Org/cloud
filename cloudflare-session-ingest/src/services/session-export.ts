import type { Env } from '../env';
import { getDb } from '../db/kysely';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { withDORetry } from '../util/do-retry';

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
  const db = getDb(env.HYPERDRIVE);

  const session = await db
    .selectFrom('cli_sessions_v2')
    .select(['session_id'])
    .where('session_id', '=', sessionId)
    .where('kilo_user_id', '=', kiloUserId)
    .executeTakeFirst();

  if (!session) {
    return null;
  }

  return withDORetry(
    () => getSessionIngestDO(env, { kiloUserId, sessionId }),
    stub => stub.getAll(),
    'SessionIngestDO.getAll'
  );
}
