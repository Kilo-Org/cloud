import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { findUserByNormalizedEmail } from '@/lib/user';
import {
  ALREADY_OWNS_DEMO,
  createSalesDemoOrganization,
  isAllowedSalesDemoEmail,
  NOT_LIVE_SALES_DEMO,
  restoreSalesDemoOrganization,
} from '@/lib/organizations/sales-demo';

export const salesDemoRouter = createTRPCRouter({
  create: adminProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input, ctx }) => {
      if (!isAllowedSalesDemoEmail(input.email)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Only emails ending in @kilocode.ai or @anaconda.com can own a sales demo organization.',
        });
      }

      const targetUser = await findUserByNormalizedEmail(input.email);
      if (!targetUser) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'This user does not exist. They must sign in once first.',
        });
      }

      try {
        const organization = await db.transaction(async tx =>
          createSalesDemoOrganization({
            targetUser,
            adminUser: ctx.user,
            txn: tx,
          })
        );

        return {
          organizationId: organization.id,
          organizationName: organization.name,
        };
      } catch (error) {
        if (error instanceof Error && error.message === ALREADY_OWNS_DEMO) {
          const cause = error.cause as { organizationId: string; organizationName: string };
          throw new TRPCError({
            code: 'CONFLICT',
            message: `${ALREADY_OWNS_DEMO}:${cause.organizationId}:${cause.organizationName}`,
          });
        }
        throw error;
      }
    }),

  reset: adminProcedure
    .input(z.object({ organizationId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
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
