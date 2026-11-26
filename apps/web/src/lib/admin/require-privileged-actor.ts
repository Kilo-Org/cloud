import 'server-only';
import { TRPCError } from '@trpc/server';
import type { User } from '@kilocode/db/schema';
import {
  createAdminAssurance,
  describePrivilegedAction,
  type PrivilegedActionClass,
  type PrivilegedActor,
  type PrivilegedTarget,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import { runStepUpGuard, stepUpDecisionCovers } from '@kilocode/web-shared/lib/admin/step-up-guard';
import { isAdminStepUpEnabled } from '@kilocode/web-shared/lib/config.server';
import { differentOperationError } from '@kilocode/web-shared/lib/admin/admin-guard';
import {
  requireStaffAuthority,
  type StaffAuthorityContext,
} from '@kilocode/web-shared/lib/trpc/init';
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

type GuardContext = StaffAuthorityContext & { tokenSource?: string | null };

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

/**
 * Asserts one independent permission against the current primary row, which
 * the staff admission read for this request.
 */
export function assertPrivilegedPermission(permission: PrivilegedPermission, currentUser: User) {
  const rule = permissionRules[permission];
  if (!rule.allowed(currentUser)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: rule.message });
  }
}

/**
 * A specialized permission on top of the staff admission. Chained on
 * `adminProcedure`, it reuses that admission: the primary row it read and,
 * when it measured a request proof, its step-up decision, which must cover this
 * action class and target. Outside `adminProcedure` it runs the admission
 * itself. Either way the request needs one primary read.
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
  const target = params.target ?? { kind: 'none', id: null };
  const upstream = ctx.adminAdmission;
  const admission =
    upstream ?? (await requireStaffAuthority(ctx, { actionClass: params.actionClass, target }));
  const currentUser = admission.user;
  assertPrivilegedPermission(params.permission, currentUser);

  let stepUp = admission.stepUp;
  if (upstream && upstream.decision) {
    // A request is evaluated once. A measured decision that does not cover
    // this action and target refuses it; the switch being off measured nothing.
    if (
      upstream.stepUp.status !== 'absent' &&
      !stepUpDecisionCovers(upstream.decision, params.actionClass, target)
    ) {
      throw differentOperationError();
    }
  } else if (upstream) {
    // The upstream admission deferred or skipped the proof, so this guard
    // measures it for its own action and target.
    stepUp = await runStepUpGuard({
      userId: currentUser.id,
      credential: 'session',
      webSessionId: ctx.webSessionId,
      actionClass: params.actionClass,
      target,
      enabled: isAdminStepUpEnabled(),
      route: ctx.trpcPath ?? null,
      method: ctx.trpcType ?? null,
      surface: 'trpc',
    });
  }

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
    credential: 'session',
    tokenSource: ctx.tokenSource ?? null,
    action: describePrivilegedAction(params.actionClass, target, params.inventoryId ?? null),
  };
}
