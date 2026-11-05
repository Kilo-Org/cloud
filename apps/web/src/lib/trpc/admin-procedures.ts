import 'server-only';
import { TRPCError } from '@trpc/server';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  canCurrentUserExportApiRequestLogs,
  canCurrentUserViewSessions,
  userIsSuperadmin,
} from '@/lib/admin/admin-permissions';
import { userCanManageCredits } from '@/lib/admin/credit-management';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { adminProcedure } from '@kilocode/web-shared/lib/trpc/init';
import { markPrivilegedGuard } from '@kilocode/web-shared/lib/admin/privileged-inventory';

export const creditManagerProcedure = adminProcedure.use(
  markPrivilegedGuard(async ({ ctx, next }) => {
    const currentUser = await getCurrentUserFromPrimary(ctx.user.id);
    if (!currentUser || currentUser.blocked_reason !== null || !userCanManageCredits(currentUser)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Credit management access required',
      });
    }

    return next();
  }, 'credit_manager')
);

async function getCurrentUserFromPrimary(userId: string) {
  return db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });
}

export const superadminProcedure = adminProcedure.use(
  markPrivilegedGuard(async ({ ctx, next }) => {
    const currentUser = await getCurrentUserFromPrimary(ctx.user.id);
    if (!currentUser || currentUser.blocked_reason !== null || !userIsSuperadmin(currentUser)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Superadmin access required',
      });
    }

    return next();
  }, 'superadmin')
);

export const sessionViewerProcedure = adminProcedure.use(
  markPrivilegedGuard(async ({ ctx, next }) => {
    if (!(await canCurrentUserViewSessions(ctx.user.id))) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Session viewing access required',
      });
    }

    return next();
  }, 'session_viewer')
);

export const apiRequestLogExporterProcedure = adminProcedure.use(
  markPrivilegedGuard(async ({ ctx, next }) => {
    if (!(await canCurrentUserExportApiRequestLogs(ctx.user.id))) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'API request log export access required',
      });
    }

    return next();
  }, 'api_request_log_exporter')
);
