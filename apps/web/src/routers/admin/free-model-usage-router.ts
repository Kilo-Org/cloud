import 'server-only';

import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { headers } from 'next/headers';
import { TRPCError } from '@trpc/server';
import {
  FREE_MODEL_RATE_LIMIT_WINDOW_HOURS,
  FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
} from '@/lib/constants';
import { fillFreeModelRateLimit, getFreeModelRateLimitUsage } from '@/lib/free-model-rate-limiter';

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

export const adminFreeModelUsageRouter = createTRPCRouter({
  getMyIpUsage: adminProcedure.query(async () => {
    const ipAddress = await getCallerIp();
    const currentUsage = await getFreeModelRateLimitUsage(ipAddress);
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
    const { requestsAdded, requestCount } = await fillFreeModelRateLimit(ipAddress);

    return {
      ipAddress,
      requestsAdded,
      newTotal: requestCount,
      alreadyRateLimited: requestsAdded === 0,
    };
  }),
});
