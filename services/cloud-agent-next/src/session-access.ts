import { getWorkerDb } from '@kilocode/db/client';
import { TRPCError } from '@trpc/server';
import {
  queryAccessibleCloudAgentSession,
  type AccessibleCloudAgentSession,
} from '@kilocode/worker-utils/cloud-agent-session-access';
import type { Env, ValidatedSessionAccess } from './types.js';

type CurrentSessionAccessRequest = {
  env: Pick<Env, 'HYPERDRIVE'>;
  kiloUserId: string;
  cloudAgentSessionId: string;
  expectedOrganizationId?: string | null;
  expectedKiloSessionId?: string;
  validatedSessionAccess?: ValidatedSessionAccess;
};

function matchesExpectedSession(
  session: AccessibleCloudAgentSession,
  request: CurrentSessionAccessRequest
): boolean {
  return (
    (request.expectedOrganizationId === undefined ||
      session.organizationId === request.expectedOrganizationId) &&
    (request.expectedKiloSessionId === undefined ||
      session.kiloSessionId === request.expectedKiloSessionId)
  );
}

export async function requireCurrentSessionAccess(
  request: CurrentSessionAccessRequest
): Promise<AccessibleCloudAgentSession> {
  const validatedSessionAccess = request.validatedSessionAccess;
  if (
    validatedSessionAccess?.kiloUserId === request.kiloUserId &&
    validatedSessionAccess.cloudAgentSessionId === request.cloudAgentSessionId &&
    matchesExpectedSession(validatedSessionAccess, request)
  ) {
    return {
      kiloSessionId: validatedSessionAccess.kiloSessionId,
      organizationId: validatedSessionAccess.organizationId,
    };
  }

  let session: AccessibleCloudAgentSession | null;
  try {
    const db = getWorkerDb(request.env.HYPERDRIVE.connectionString);
    session = await queryAccessibleCloudAgentSession(db, {
      kiloUserId: request.kiloUserId,
      cloudAgentSessionId: request.cloudAgentSessionId,
    });
  } catch {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Session access is temporarily unavailable',
    });
  }

  if (!session || !matchesExpectedSession(session, request)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
  }

  return session;
}

export function projectSessionAccessHttpError(error: unknown): Response {
  if (error instanceof TRPCError && error.code === 'FORBIDDEN') {
    return new Response('Session access denied', { status: 403 });
  }
  return new Response('Session access is temporarily unavailable', { status: 503 });
}
