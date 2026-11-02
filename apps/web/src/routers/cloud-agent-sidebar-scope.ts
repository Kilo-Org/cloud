import 'server-only';
import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { isGoneOrDeletingBlockedReason } from '@kilocode/db/user-soft-delete';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, type AnyColumn, type SQL } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { baseProcedure } from '@kilocode/web-shared/lib/trpc/init';

export const uuidSchema = z.uuid().transform(id => id.toLowerCase());

export const scopeInputSchema = z.object({ organizationId: uuidSchema.nullable() });

export type SidebarScope = { userId: string; organizationId: string | null };

type OwnerScopedTable = {
  kilo_user_id: AnyColumn;
  organization_id: AnyColumn;
};

export function ownerScopeCondition(table: OwnerScopedTable, scope: SidebarScope): SQL {
  return and(
    eq(table.kilo_user_id, scope.userId),
    scope.organizationId === null
      ? isNull(table.organization_id)
      : eq(table.organization_id, scope.organizationId)
  ) as SQL;
}

export const cloudAgentSidebarScopeProcedure = baseProcedure
  .input(scopeInputSchema)
  .use(async ({ ctx, input, type, next }) =>
    db.transaction(async tx => {
      const scope: SidebarScope = { userId: ctx.user.id, organizationId: input.organizationId };
      const [user] = await tx
        .select({ blockedReason: kilocode_users.blocked_reason })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, scope.userId))
        .for(type === 'mutation' ? 'no key update' : 'key share');

      if (!user || isGoneOrDeletingBlockedReason(user.blockedReason)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace folders are unavailable' });
      }

      if (scope.organizationId !== null) {
        const [membership] = await tx
          .select({ id: organization_memberships.id })
          .from(organization_memberships)
          .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
          .where(
            and(
              eq(organization_memberships.kilo_user_id, scope.userId),
              eq(organization_memberships.organization_id, scope.organizationId),
              isNull(organizations.deleted_at)
            )
          )
          .for('share', { of: organization_memberships });
        if (!membership) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Organization membership required' });
        }
      }

      const result = await next({ ctx: { sidebarDb: tx, sidebarScope: scope } });
      if (!result.ok) throw result.error;
      return result;
    })
  );
