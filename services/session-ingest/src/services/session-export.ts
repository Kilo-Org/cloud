import type { Env } from '../env';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { resolveAccessibleKiloSession } from './session-access';
import { withDORetry } from '@kilocode/worker-utils';

/**
 * Fetch the full session export as a streaming ReadableStream.
 *
 * Verifies that the session belongs to the user and that organization access
 * is current before reading the DO.
 *
 * @returns A ReadableStream of the JSON payload, or `null` if the session
 *          does not exist or does not belong to the user.
 */
export async function getSessionExport(
  env: Env,
  sessionId: string,
  kiloUserId: string
): Promise<ReadableStream<Uint8Array> | null> {
  const accessibleSession = await resolveAccessibleKiloSession(env, {
    kiloUserId,
    kiloSessionId: sessionId,
  });
  if (!accessibleSession) {
    return null;
  }

  return withDORetry(
    () => getSessionIngestDO(env, { kiloUserId, sessionId }),
    stub => stub.getAllStream(),
    'SessionIngestDO.getAllStream'
  );
}
