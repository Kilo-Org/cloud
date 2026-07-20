import { getWorkerDb } from '@kilocode/db/client';
import { queryAccessibleKiloSession } from '@kilocode/worker-utils/cloud-agent-session-access';
import type { Env } from '../env';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { withDORetry } from '@kilocode/worker-utils';

export type AccessibleKiloSession = {
  kiloSessionId: string;
  organizationId: string | null;
};

type ResolveAccessibleKiloSessionParams = {
  kiloUserId: string;
  kiloSessionId: string;
};

export async function resolveAccessibleKiloSession(
  env: Env,
  params: ResolveAccessibleKiloSessionParams
): Promise<AccessibleKiloSession | null> {
  try {
    const cached = await withDORetry(
      () => getSessionAccessCacheDO(env, { kiloUserId: params.kiloUserId }),
      sessionCache => sessionCache.getAccess(params.kiloSessionId),
      'SessionAccessCacheDO.getAccess'
    );
    if (cached) {
      return {
        kiloSessionId: cached.sessionId,
        organizationId: cached.organizationId,
      };
    }
  } catch {
    // Cache availability must not decide authorization.
  }

  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const session = await queryAccessibleKiloSession(db, params);
  if (!session) {
    return null;
  }

  try {
    await withDORetry(
      () => getSessionAccessCacheDO(env, { kiloUserId: params.kiloUserId }),
      sessionCache =>
        sessionCache.putValidated({
          sessionId: session.kiloSessionId,
          organizationId: session.organizationId,
        }),
      'SessionAccessCacheDO.putValidated'
    );
  } catch {
    // A failed cache write does not invalidate the authoritative database result.
  }

  return session;
}
