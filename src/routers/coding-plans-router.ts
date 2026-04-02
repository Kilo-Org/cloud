import { createTRPCRouter, baseProcedure, adminProcedure } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { coding_plan_subscriptions } from '@kilocode/db/schema';
import { getCodingPlanCatalog } from '@/lib/coding-plans/pricing';
import {
  subscribeToCodingPlan,
  cancelCodingPlanSubscription,
  cancelCodingPlanImmediately,
  uploadKeysToInventory,
  getKeyInventoryCounts,
} from '@/lib/coding-plans';

export const codingPlansRouter = createTRPCRouter({
  // -----------------------------------------------------------------------
  // User endpoints
  // -----------------------------------------------------------------------

  /** Returns the plan catalog with pricing (spec §1.1, §1.2). */
  catalog: baseProcedure.query(() => {
    return getCodingPlanCatalog();
  }),

  /** Returns all coding plan subscriptions for the authenticated user. */
  listSubscriptions: baseProcedure.query(async ({ ctx }) => {
    return db
      .select({
        id: coding_plan_subscriptions.id,
        provider_id: coding_plan_subscriptions.provider_id,
        status: coding_plan_subscriptions.status,
        cost_microdollars: coding_plan_subscriptions.cost_microdollars,
        billing_period_days: coding_plan_subscriptions.billing_period_days,
        current_period_start: coding_plan_subscriptions.current_period_start,
        current_period_end: coding_plan_subscriptions.current_period_end,
        cancel_at_period_end: coding_plan_subscriptions.cancel_at_period_end,
        canceled_at: coding_plan_subscriptions.canceled_at,
        created_at: coding_plan_subscriptions.created_at,
      })
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.user_id, ctx.user.id));
  }),

  /** Subscribe to a coding plan. */
  subscribe: baseProcedure
    .input(z.object({ providerId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await subscribeToCodingPlan(ctx.user.id, input.providerId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('Insufficient credit balance')) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
        }
        if (message.includes('not available as a coding plan')) {
          throw new TRPCError({ code: 'NOT_FOUND', message });
        }
        if (message.includes('No pre-purchased API key available')) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
        }
        if (message.includes('already processed')) {
          throw new TRPCError({ code: 'CONFLICT', message });
        }
        if (message.includes('already have a BYOK key')) {
          throw new TRPCError({ code: 'CONFLICT', message });
        }

        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /** Cancel subscription at period end. */
  cancel: baseProcedure
    .input(z.object({ providerId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        await cancelCodingPlanSubscription(ctx.user.id, input.providerId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('No active subscription')) {
          throw new TRPCError({ code: 'NOT_FOUND', message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  // -----------------------------------------------------------------------
  // Admin endpoints
  // -----------------------------------------------------------------------

  /** Admin: Get key inventory counts per provider. */
  adminKeyInventory: adminProcedure
    .input(z.object({ providerId: z.string().optional() }))
    .query(async ({ input }) => {
      return getKeyInventoryCounts(input.providerId);
    }),

  /** Admin: Upload pre-purchased keys to inventory. */
  adminUploadKeys: adminProcedure
    .input(
      z.object({
        providerId: z.string(),
        keys: z.array(z.string().min(1)).min(1).max(1000),
      })
    )
    .mutation(async ({ input }) => {
      return uploadKeysToInventory(input.providerId, input.keys);
    }),

  /** Admin: Immediately cancel a user's coding plan subscription. */
  adminCancelSubscription: adminProcedure
    .input(z.object({ userId: z.string(), providerId: z.string() }))
    .mutation(async ({ input }) => {
      try {
        await cancelCodingPlanImmediately(input.userId, input.providerId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('No active subscription')) {
          throw new TRPCError({ code: 'NOT_FOUND', message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),
});
