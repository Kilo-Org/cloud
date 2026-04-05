import { eq, and } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';

import type { Env } from '../env';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { withDORetry } from '@kilocode/worker-utils';

/**
 * Verify that the session exists in `cli_sessions_v2` and belongs to the
 * given user.
 */
async function verifySessionOwnership(
  env: Env,
  sessionId: string,
  kiloUserId: string
): Promise<boolean> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);

  const rows = await db
    .select({ session_id: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
    )
    .limit(1);

  return !!rows[0];
}

/**
 * Fetch the full session export as a streaming ReadableStream.
 *
 * Verifies that the session exists in `cli_sessions_v2` and belongs to the
 * given user before reading the DO.
 *
 * @returns A ReadableStream of the JSON payload, or `null` if the session
 *          does not exist or does not belong to the user.
 */
export async function getSessionExport(
  env: Env,
  sessionId: string,
  kiloUserId: string
): Promise<ReadableStream<Uint8Array> | null> {
  const owned = await verifySessionOwnership(env, sessionId, kiloUserId);
  if (!owned) {
    return null;
  }

  return withDORetry(
    () => getSessionIngestDO(env, { kiloUserId, sessionId }),
    stub => stub.getAllStream(),
    'SessionIngestDO.getAllStream'
  );
}
