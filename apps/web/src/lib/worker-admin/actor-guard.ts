import 'server-only';
import { eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import {
  createAdminAssurance,
  describePrivilegedAction,
  type PrivilegedActor,
  type PrivilegedTarget,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromSessionForCredentialIssuance } from '@kilocode/web-shared/lib/user/server';

/**
 * Port between the capability issuer and PR2's session-bound MFA step-up.
 * PR5 swaps this implementation for `requirePrivilegedActor`; the issuer only
 * depends on this narrow interface.
 */
export type WorkerAdminActorRequirement = {
  actionClass: 'worker_admin' | 'support_read';
  target: PrivilegedTarget;
  inventoryId: string;
};

export type WorkerAdminActor = {
  actor: PrivilegedActor;
  sessionBinding: {
    apiTokenPepper: string | null;
    webSessionPepper: string | null;
  };
};

export type RequireWorkerAdminActor = (
  req: Request | null,
  headers: Headers,
  requirement: WorkerAdminActorRequirement
) => Promise<WorkerAdminActor>;

export class WorkerAdminActorError extends Error {
  constructor(
    public readonly status: 401 | 403 | 503,
    public readonly code:
      | 'session_required'
      | 'authentication_required'
      | 'not_admin'
      | 'blocked'
      | 'step_up_required',
    message: string
  ) {
    super(message);
    this.name = 'WorkerAdminActorError';
  }
}

type AdminUser = Pick<
  User,
  'id' | 'google_user_email' | 'is_admin' | 'is_super_admin' | 'api_token_pepper' | 'blocked_at'
>;

async function reReadAdminUser(userId: string): Promise<AdminUser | null> {
  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
    columns: {
      id: true,
      google_user_email: true,
      is_admin: true,
      is_super_admin: true,
      api_token_pepper: true,
      blocked_at: true,
    },
  });
  return user ?? null;
}

/**
 * Interim adapter. It accepts only the session cookie (any `Authorization`
 * header is refused), re-reads `is_admin`/`blocked_at` on the primary, and
 * requires a fresh step-up. PR1's step-up state is a permanent `absent`, so
 * this always fails until PR2 lands — which is why capability issuance must
 * stay off in production before then.
 */
export const requireWorkerAdminActor: RequireWorkerAdminActor = async (
  _req,
  headers,
  requirement
) => {
  if (headers.has('authorization')) {
    throw new WorkerAdminActorError(
      401,
      'session_required',
      'Worker admin capabilities may only be minted from a browser session'
    );
  }

  const session = await getUserFromSessionForCredentialIssuance();
  if (!session.user) {
    throw new WorkerAdminActorError(401, 'authentication_required', 'Authentication required');
  }

  const user = await reReadAdminUser(session.user.id);
  if (!user) {
    throw new WorkerAdminActorError(401, 'authentication_required', 'Authentication required');
  }
  if (user.blocked_at) {
    throw new WorkerAdminActorError(403, 'blocked', 'Account is blocked');
  }
  if (!user.is_admin) {
    throw new WorkerAdminActorError(403, 'not_admin', 'Admin access required');
  }

  const assurance = createAdminAssurance({
    userId: user.id,
    permissions: {
      isAdmin: true,
      isSuperAdmin: user.is_super_admin,
      canViewSessions: true,
      canManageCredits: true,
      canExportApiRequestLogs: true,
    },
  });
  // PR1 models step-up as `{ status: 'absent' }` only. Read it structurally so
  // this adapter compiles before and after PR2 extends the union.
  const stepUpStatus = (assurance.stepUp as { status: string }).status;
  if (stepUpStatus !== 'fresh') {
    throw new WorkerAdminActorError(
      403,
      'step_up_required',
      'Fresh multi-factor step-up is required to issue a Worker admin capability'
    );
  }

  return {
    actor: {
      assurance,
      credential: 'session',
      tokenSource: null,
      action: describePrivilegedAction(
        requirement.actionClass,
        requirement.target,
        requirement.inventoryId
      ),
    },
    sessionBinding: { apiTokenPepper: user.api_token_pepper, webSessionPepper: null },
  };
};
