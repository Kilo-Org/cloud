import 'server-only';
import { adminProcedure } from '@kilocode/web-shared/lib/trpc/init';
import {
  actionClassForAdminProcedure,
  markPrivilegedGuard,
} from '@kilocode/web-shared/lib/admin/privileged-inventory';
import { requirePrivilegedActor } from '@/lib/admin/require-privileged-actor';

export const creditManagerProcedure = adminProcedure.use(
  markPrivilegedGuard(async ({ ctx, path, type, next }) => {
    const { actionClass, inventoryId } = actionClassForAdminProcedure(path, type);
    await requirePrivilegedActor({ permission: 'credit_manager', actionClass, inventoryId }, ctx);
    return next();
  }, 'credit_manager')
);

export const superadminProcedure = adminProcedure.use(
  markPrivilegedGuard(async ({ ctx, path, type, next }) => {
    const { actionClass, inventoryId } = actionClassForAdminProcedure(path, type);
    await requirePrivilegedActor({ permission: 'superadmin', actionClass, inventoryId }, ctx);
    return next();
  }, 'superadmin')
);

export const sessionViewerProcedure = adminProcedure.use(
  markPrivilegedGuard(async ({ ctx, path, type, next }) => {
    const { actionClass, inventoryId } = actionClassForAdminProcedure(path, type);
    await requirePrivilegedActor({ permission: 'session_viewer', actionClass, inventoryId }, ctx);
    return next();
  }, 'session_viewer')
);

export const apiRequestLogExporterProcedure = adminProcedure.use(
  markPrivilegedGuard(async ({ ctx, path, type, next }) => {
    const { actionClass, inventoryId } = actionClassForAdminProcedure(path, type);
    await requirePrivilegedActor(
      { permission: 'api_request_log_exporter', actionClass, inventoryId },
      ctx
    );
    return next();
  }, 'api_request_log_exporter')
);
