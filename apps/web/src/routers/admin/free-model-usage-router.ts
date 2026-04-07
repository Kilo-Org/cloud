import 'server-only';

import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { free_model_usage } from '@kilocode/db/schema';
import { and, count, gte } from 'drizzle-orm';
import { headers } from 'next/headers';
import { TRPCError } from '@trpc/server';
import {
  FREE_MODEL_RATE_LIMIT_WINDOW_HOURS,
  FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
  ADMIN_RATE_LIMIT_TEST_MODEL,
} from '@/lib/constants';
import { sql } from 'drizzle-orm';

function getWindowStart(): Date {
  return new Date(Date.now() - FREE_MODEL_RATE_LIMIT_WINDOW_HOURS * 60 * 60 * 1000);
}

async function getCallerIp(): Promise<string> {
  const headersList = await headers();
  const forwarded = headersList.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim();
  if (!ip) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Unable to determine client IP address',
    });
  }
  return ip;
}

async function countUsageForIp(ipAddress: string): Promise<number> {
  const windowStart = getWindowStart();
  const usage = await db
    .select({ totalRequests: count() })
    .from(free_model_usage)
    .where(
      and(
        sql`${free_model_usage.ip_address} = ${ipAddress}`,
        gte(free_model_usage.created_at, windowStart.toISOString())
      )
    );
  return Number(usage[0]?.totalRequests ?? 0);
}

export const adminFreeModelUsageRouter = createTRPCRouter({
  getMyIpUsage: adminProcedure.query(async () => {
    const ipAddress = await getCallerIp();
    const currentUsage = await countUsageForIp(ipAddress);
    return {
      ipAddress,
      currentUsage,
      limit: FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
      windowHours: FREE_MODEL_RATE_LIMIT_WINDOW_HOURS,
      isRateLimited: currentUsage >= FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
    };
  }),

  rateLimitMyIp: adminProcedure.mutation(async () => {
    const ipAddress = await getCallerIp();
    const currentUsage = await countUsageForIp(ipAddress);
    const rowsNeeded = FREE_MODEL_MAX_REQUESTS_PER_WINDOW - currentUsage;

    if (rowsNeeded <= 0) {
      return {
        ipAddress,
        rowsInserted: 0,
        newTotal: currentUsage,
        alreadyRateLimited: true,
      };
    }

    const rows = Array.from({ length: rowsNeeded }, () => ({
      ip_address: ipAddress,
      model: ADMIN_RATE_LIMIT_TEST_MODEL,
    }));

    await db.insert(free_model_usage).values(rows);

    return {
      ipAddress,
      rowsInserted: rowsNeeded,
      newTotal: FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
      alreadyRateLimited: false,
    };
  }),
});
