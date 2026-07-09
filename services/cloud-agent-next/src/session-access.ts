import { getWorkerDb } from '@kilocode/db/client';
import { organization_memberships } from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import {
  queryAccessibleCloudAgentSession,
  type AccessibleCloudAgentSession,
} from '@kilocode/worker-utils/cloud-agent-session-access';
import { and, eq } from 'drizzle-orm';
import type { Env, ValidatedSessionAccess } from './types.js';

type CurrentSessionAccessRequest = {
  env: Pick<Env, 'HYPERDRIVE'>;
  kiloUserId: string;
  cloudAgentSessionId: string;
  expectedOrganizationId?: string | null;
  expectedKiloSessionId?: string;
  validatedSessionAccess?: ValidatedSessionAccess;
};

export async function assertOrganizationMembership(
  db: WorkerDb,
  userId: string,
  organizationId: string
): Promise<void> {
  const [membership] = await db
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, userId)
      )
    )
    .limit(1);

  if (!membership) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have access to this organization',
    });
  }
}

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
