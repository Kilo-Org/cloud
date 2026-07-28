import { getWorkerDb } from '@kilocode/db/client';
import { queryAccessibleKiloSessionWithSessionScope } from '@kilocode/worker-utils/cloud-agent-session-access';
import type { Env } from '../env';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { withDORetry } from '@kilocode/worker-utils';

export type AccessibleKiloSession = {
  kiloSessionId: string;
  organizationId: string | null;
  cloudAgentSessionScopeId: string | null;
};

type ResolveAccessibleKiloSessionParams = {
  kiloUserId: string;
  kiloSessionId: string;
  expectedCloudAgentSessionScopeId?: string;
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
      (params.expectedCloudAgentSessionScopeId === undefined ||
        cached.cloudAgentSessionScopeId === params.expectedCloudAgentSessionScopeId)
    ) {
      return {
        kiloSessionId: cached.sessionId,
        organizationId: cached.organizationId,
        cloudAgentSessionScopeId: cached.cloudAgentSessionScopeId,
      };
    }
  } catch {
    // Cache availability must not decide authorization.
  }

  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const session = await queryAccessibleKiloSessionWithSessionScope(db, params);
  if (!session) {
    return null;
  }
  const normalizedSession = {
    ...session,
    cloudAgentSessionScopeId: session.cloudAgentSessionScopeId ?? null,
  };

  try {
    await withDORetry(
      () => getSessionAccessCacheDO(env, { kiloUserId: params.kiloUserId }),
      sessionCache =>
        sessionCache.putValidated({
          sessionId: normalizedSession.kiloSessionId,
          organizationId: normalizedSession.organizationId,
          cloudAgentSessionScopeId: normalizedSession.cloudAgentSessionScopeId,
        }),
      'SessionAccessCacheDO.putValidated'
    );
  } catch {
    // A failed cache write does not invalidate the authoritative database result.
  }

  return normalizedSession;
}
