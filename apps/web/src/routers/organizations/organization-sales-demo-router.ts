import { createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { NOT_LIVE_SALES_DEMO, restoreSalesDemoOrganization } from '@/lib/organizations/sales-demo';
import {
  ensureOrganizationAccess,
  organizationMemberMutationProcedure,
} from '@/routers/organizations/utils';

export const organizationSalesDemoRouter = createTRPCRouter({
  reset: organizationMemberMutationProcedure.mutation(async ({ input, ctx }) => {
    await ensureOrganizationAccess(ctx, input.organizationId, ['owner']);

    try {
      return await db.transaction(async tx => {
        const organizationId = await restoreSalesDemoOrganization({
          organizationId: input.organizationId,
          actorUser: ctx.user,
          txn: tx,
        });

        const [org] = await tx
          .select({ name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .limit(1);

        return {
          organizationId,
          organizationName: org?.name ?? '',
        };
      });
    } catch (error) {
      if (error instanceof Error && error.message === NOT_LIVE_SALES_DEMO) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization is not a live sales demo',
        });
      }
      throw error;
    }
  }),
});
