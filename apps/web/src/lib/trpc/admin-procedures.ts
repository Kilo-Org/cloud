import 'server-only';
import { TRPCError } from '@trpc/server';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { userCanViewSessions, userIsSuperadmin } from '@/lib/admin/admin-permissions';
import { userCanManageCredits } from '@/lib/admin/credit-management';
import { db } from '@/lib/drizzle';
import { adminProcedure } from '@/lib/trpc/init';

export const creditManagerProcedure = adminProcedure.use(async ({ ctx, next }) => {
  const currentUser = await getCurrentUserFromPrimary(ctx.user.id);
  if (!currentUser || currentUser.blocked_reason !== null || !userCanManageCredits(currentUser)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Credit management access required',
    });
  }

  return next();
});

async function getCurrentUserFromPrimary(userId: string) {
  return db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });
}

export const superadminProcedure = adminProcedure.use(async ({ ctx, next }) => {
  const currentUser = await getCurrentUserFromPrimary(ctx.user.id);
  if (!currentUser || currentUser.blocked_reason !== null || !userIsSuperadmin(currentUser)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Superadmin access required',
    });
  }

  return next();
});

export const sessionViewerProcedure = adminProcedure.use(async ({ ctx, next }) => {
  const currentUser = await getCurrentUserFromPrimary(ctx.user.id);

  if (!currentUser || currentUser.blocked_reason !== null || !userCanViewSessions(currentUser)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Session viewing access required',
    });
  }

  return next();
});
