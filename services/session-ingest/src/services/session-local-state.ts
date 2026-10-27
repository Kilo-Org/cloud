import { withDORetry } from '@kilocode/worker-utils';
import type { Env } from '../env';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { getUserConnectionDO } from '../dos/UserConnectionDO';

/** Clears every cache and ingest object that can serve a deleted session. */
export async function clearSessionLocalState(
  env: Env,
  kiloUserId: string,
  sessionId: string
): Promise<void> {
  await withDORetry(
    () => getSessionAccessCacheDO(env, { kiloUserId }),
    sessionCache => sessionCache.remove(sessionId),
    'SessionAccessCacheDO.remove'
  );
  await withDORetry(
    () => getSessionIngestDO(env, { kiloUserId, sessionId }),
    stub => stub.clear(),
    'SessionIngestDO.clear'
  );
  await withDORetry(
    () => getUserConnectionDO(env, { kiloUserId }),
    stub => stub.clearSession(sessionId),
    'UserConnectionDO.clearSession'
  );
}
