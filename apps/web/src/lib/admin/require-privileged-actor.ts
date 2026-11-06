import 'server-only';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  createAdminAssurance,
  deriveCredentialKind,
  describePrivilegedAction,
  type PrivilegedActionClass,
  type PrivilegedActor,
  type PrivilegedTarget,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import { runStepUpGuard } from '@kilocode/web-shared/lib/admin/step-up-guard';
import { isAdminStepUpEnabled } from '@kilocode/web-shared/lib/config.server';
import { isWebSessionCurrent } from '@kilocode/web-shared/lib/web-session-revocation';
import {
  userCanExportApiRequestLogs,
  userCanViewSessions,
  userIsSuperadmin,
} from '@/lib/admin/admin-permissions';
import { userCanManageCredits } from '@/lib/admin/credit-management';

export type PrivilegedPermission =
  | 'admin'
  | 'superadmin'
  | 'credit_manager'
  | 'session_viewer'
  | 'api_request_log_exporter';

type GuardContext = {
  user: User;
  credential?: ReturnType<typeof deriveCredentialKind>;
  webSessionId?: string;
  webSessionPepper?: string | null;
  authViaToken?: boolean;
  tokenSource?: string | null;
  internalApiUse?: boolean;
  headersList?: Headers;
  ip?: string | null;
  trpcPath?: string;
  trpcType?: string;
  adminStepUpState?: PrivilegedActor['assurance']['stepUp'];
};

const permissionRules: Record<
  PrivilegedPermission,
  { allowed: (user: User) => boolean; message: string }
> = {
  admin: { allowed: user => user.is_admin, message: 'Admin access required' },
  superadmin: {
    allowed: user => userIsSuperadmin(user),
    message: 'Superadmin access required',
  },
  credit_manager: {
    allowed: user => userCanManageCredits(user),
    message: 'Credit management access required',
  },
  session_viewer: {
    allowed: user => userCanViewSessions(user),
    message: 'Session viewing access required',
  },
  api_request_log_exporter: {
    allowed: user => userCanExportApiRequestLogs(user),
    message: 'API request log export access required',
  },
};

async function loadPrimaryActor(userId: string): Promise<User | undefined> {
  return db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });
}

/**
 * Asserts one independent permission against the primary user row. The message
 * is the same one the pre-PR2 guard used, so existing callers see no change.
 */
export async function assertPrivilegedPermission(
  permission: PrivilegedPermission,
  ctx: Pick<GuardContext, 'user'>
): Promise<User> {
  const currentUser = await loadPrimaryActor(ctx.user.id);
  const rule = permissionRules[permission];
  if (!currentUser || currentUser.blocked_reason !== null || !rule.allowed(currentUser)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: rule.message });
  }
  return currentUser;
}

/**
 * PR1's privileged actor, now with step-up assurance. Always re-reads the
 * permission on the primary. When step-up is enabled it denies a missing or
 * stale proof; when the caller is chained on adminProcedure, the decision from
 * the admin middleware is reused instead of evaluating twice.
 */
export async function requirePrivilegedActor(
  params: {
    permission: PrivilegedPermission;
    actionClass: PrivilegedActionClass;
    target?: PrivilegedTarget;
    inventoryId?: string | null;
  },
  ctx: GuardContext
): Promise<PrivilegedActor> {
  const currentUser = await assertPrivilegedPermission(params.permission, ctx);
  const credential =
    ctx.credential ??
    deriveCredentialKind({
      authViaToken: ctx.authViaToken ?? false,
      tokenSource: ctx.tokenSource ?? null,
      internalApiUse: ctx.internalApiUse,
    });

  // `isWebSessionCurrent` normalizes an absent pepper to null, so a session
  // credential is always compared against the primary row.
  if (credential === 'session' && !isWebSessionCurrent(ctx.webSessionPepper, currentUser)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Reauthentication required' });
  }

  const target = params.target ?? { kind: 'none', id: null };
  const stepUp =
    ctx.adminStepUpState ??
    (await runStepUpGuard({
      userId: currentUser.id,
      credential,
      webSessionId: ctx.webSessionId,
      actionClass: params.actionClass,
      enabled: isAdminStepUpEnabled(),
      route: ctx.trpcPath ?? null,
      method: ctx.trpcType ?? null,
      surface: 'trpc',
    }));

  return {
    assurance: createAdminAssurance({
      userId: currentUser.id,
      permissions: {
        isAdmin: currentUser.is_admin,
        isSuperAdmin: userIsSuperadmin(currentUser),
        canViewSessions: userCanViewSessions(currentUser),
        canManageCredits: userCanManageCredits(currentUser),
        canExportApiRequestLogs: userCanExportApiRequestLogs(currentUser),
      },
      stepUp,
    }),
    credential,
    tokenSource: ctx.tokenSource ?? null,
    action: describePrivilegedAction(params.actionClass, target, params.inventoryId ?? null),
  };
}
