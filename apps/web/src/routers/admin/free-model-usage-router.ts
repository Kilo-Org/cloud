import 'server-only';

import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { free_model_usage } from '@kilocode/db/schema';
import { and, count, eq, gte } from 'drizzle-orm';
import {
  FREE_MODEL_RATE_LIMIT_WINDOW_HOURS,
  FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
  ADMIN_RATE_LIMIT_TEST_MODEL,
} from '@/lib/constants';

function getWindowStart(): Date {
  return new Date(Date.now() - FREE_MODEL_RATE_LIMIT_WINDOW_HOURS * 60 * 60 * 1000);
}

async function countUsageForUser(kiloUserId: string): Promise<number> {
  const windowStart = getWindowStart();
  const usage = await db
    .select({ totalRequests: count() })
    .from(free_model_usage)
    .where(
      and(
        eq(free_model_usage.kilo_user_id, kiloUserId),
        gte(free_model_usage.created_at, windowStart.toISOString())
      )
    );
  return Number(usage[0]?.totalRequests ?? 0);
}

export const adminFreeModelUsageRouter = createTRPCRouter({
  getMyUsage: adminProcedure.query(async ({ ctx }) => {
    const kiloUserId = ctx.user.id;
    const currentUsage = await countUsageForUser(kiloUserId);
    return {
      kiloUserId,
      currentUsage,
      limit: FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
      windowHours: FREE_MODEL_RATE_LIMIT_WINDOW_HOURS,
      isRateLimited: currentUsage >= FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
    };
  }),

  rateLimitMe: adminProcedure.mutation(async ({ ctx }) => {
    const kiloUserId = ctx.user.id;
    const currentUsage = await countUsageForUser(kiloUserId);
    const rowsNeeded = FREE_MODEL_MAX_REQUESTS_PER_WINDOW - currentUsage;

    if (rowsNeeded <= 0) {
      return {
        kiloUserId,
        rowsInserted: 0,
        newTotal: currentUsage,
        alreadyRateLimited: true,
      };
    }

    // ip_address is NOT NULL; use a sentinel since the per-user limit ignores IP.
    const rows = Array.from({ length: rowsNeeded }, () => ({
      ip_address: 'admin-rate-limit-test',
      model: ADMIN_RATE_LIMIT_TEST_MODEL,
      kilo_user_id: kiloUserId,
    }));

    await db.insert(free_model_usage).values(rows);

    return {
      kiloUserId,
      rowsInserted: rowsNeeded,
      newTotal: FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
      alreadyRateLimited: false,
    };
  }),
});
