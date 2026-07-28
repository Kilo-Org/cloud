import { getWorkerDb } from '@kilocode/db/client';
import { queryAccessibleKiloSession } from '@kilocode/worker-utils/cloud-agent-session-access';
import type { Env } from '../env';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { withDORetry } from '@kilocode/worker-utils';

export type AccessibleKiloSession = {
  kiloSessionId: string;
  organizationId: string | null;
  cloudAgentFamilyId: string | null;
};

type ResolveAccessibleKiloSessionParams = {
  kiloUserId: string;
  kiloSessionId: string;
  expectedCloudAgentFamilyId?: string;
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
    if (
      cached &&
      (params.expectedCloudAgentFamilyId === undefined ||
        cached.cloudAgentFamilyId === params.expectedCloudAgentFamilyId)
    ) {
      return {
        kiloSessionId: cached.sessionId,
        organizationId: cached.organizationId,
        cloudAgentFamilyId: cached.cloudAgentFamilyId,
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
  const normalizedSession = {
    ...session,
    cloudAgentFamilyId: session.cloudAgentFamilyId ?? null,
  };

  try {
    await withDORetry(
      () => getSessionAccessCacheDO(env, { kiloUserId: params.kiloUserId }),
      sessionCache =>
        sessionCache.putValidated({
          sessionId: normalizedSession.kiloSessionId,
          organizationId: normalizedSession.organizationId,
          cloudAgentFamilyId: normalizedSession.cloudAgentFamilyId,
        }),
      'SessionAccessCacheDO.putValidated'
    );
  } catch {
    // A failed cache write does not invalidate the authoritative database result.
  }

  return normalizedSession;
}
