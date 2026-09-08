import * as z from 'zod';
import { ai_gateway_request_logging_opt_ins } from '@kilocode/db/schema';
import { createCachedFetch } from '@/lib/cached-fetch';
import { db } from '@/lib/drizzle';
import { redisClient } from '@/lib/redis';
import {
  AI_GATEWAY_STATE_REDIS_TTL_SECONDS,
  REQUEST_LOGGING_OPT_INS_REDIS_KEY,
} from '@/lib/redis-keys';
import { eq } from 'drizzle-orm';

export const RequestLoggingOptInSchema = z.object({
  id: z.string().uuid(),
  target_type: z.enum(['account', 'organization']),
  target_id: z.string().trim().min(1).max(255),
  reason: z.string().trim().min(1).max(1000),
  added_by_email: z.string().email(),
  added_at: z.string().datetime(),
});

export const RequestLoggingOptInsSchema = z.array(RequestLoggingOptInSchema).max(500);

export type RequestLoggingOptIn = z.infer<typeof RequestLoggingOptInSchema>;

const REQUEST_LOGGING_OPT_INS_CACHE_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 10_000;

export function hasMatchingRequestLoggingOptIn(
  optIns: RequestLoggingOptIn[],
  params: { accountId: string | null; organizationId: string | null }
): boolean {
  return optIns.some(
    entry =>
      (entry.target_type === 'account' && entry.target_id === params.accountId) ||
      (entry.target_type === 'organization' && entry.target_id === params.organizationId)
  );
}

export async function getRequestLoggingOptIns(): Promise<RequestLoggingOptIn[]> {
  const [row] = await db
    .select({ optIns: ai_gateway_request_logging_opt_ins.opt_ins })
    .from(ai_gateway_request_logging_opt_ins)
    .where(eq(ai_gateway_request_logging_opt_ins.id, 1))
    .limit(1);
  return RequestLoggingOptInsSchema.parse(row?.optIns ?? []);
}

const getCachedRequestLoggingOptIns = createCachedFetch<RequestLoggingOptIn[]>(
  getRequestLoggingOptIns,
  REQUEST_LOGGING_OPT_INS_CACHE_TTL_MS,
  []
);

async function mirrorRequestLoggingOptInsToRedis(optIns: RequestLoggingOptIn[]): Promise<void> {
  await redisClient.set(REQUEST_LOGGING_OPT_INS_REDIS_KEY, JSON.stringify(optIns), {
    ex: AI_GATEWAY_STATE_REDIS_TTL_SECONDS,
  });
}

export async function createRequestLoggingOptIn(
  entry: RequestLoggingOptIn
): Promise<'created' | 'duplicate' | 'full'> {
  const validated = RequestLoggingOptInSchema.parse(entry);
  return db.transaction(async tx => {
    await tx
      .insert(ai_gateway_request_logging_opt_ins)
      .values({ opt_ins: [] })
      .onConflictDoNothing();
    const [row] = await tx
      .select({ optIns: ai_gateway_request_logging_opt_ins.opt_ins })
      .from(ai_gateway_request_logging_opt_ins)
      .where(eq(ai_gateway_request_logging_opt_ins.id, 1))
      .for('update');
    if (!row) throw new Error('Request logging opt-in state row is missing');

    const optIns = RequestLoggingOptInsSchema.parse(row.optIns);
    if (
      optIns.some(
        optIn =>
          optIn.target_type === validated.target_type && optIn.target_id === validated.target_id
      )
    ) {
      return 'duplicate' as const;
    }
    if (optIns.length >= 500) return 'full' as const;

    const updatedOptIns = [...optIns, validated];
    await tx
      .update(ai_gateway_request_logging_opt_ins)
      .set({ opt_ins: updatedOptIns })
      .where(eq(ai_gateway_request_logging_opt_ins.id, 1));
    await mirrorRequestLoggingOptInsToRedis(updatedOptIns);
    return 'created' as const;
  });
}

export async function deleteRequestLoggingOptIn(id: string): Promise<boolean> {
  return db.transaction(async tx => {
    const [row] = await tx
      .select({ optIns: ai_gateway_request_logging_opt_ins.opt_ins })
      .from(ai_gateway_request_logging_opt_ins)
      .where(eq(ai_gateway_request_logging_opt_ins.id, 1))
      .for('update');
    if (!row) return false;

    const optIns = RequestLoggingOptInsSchema.parse(row.optIns);
    const remaining = optIns.filter(entry => entry.id !== id);
    if (remaining.length === optIns.length) return false;

    await tx
      .update(ai_gateway_request_logging_opt_ins)
      .set({ opt_ins: remaining })
      .where(eq(ai_gateway_request_logging_opt_ins.id, 1));
    await mirrorRequestLoggingOptInsToRedis(remaining);
    return true;
  });
}

export async function isDynamicallyOptedIntoRequestLogging(params: {
  accountId: string | null;
  organizationId: string | null;
}): Promise<boolean> {
  try {
    const optIns = await getCachedRequestLoggingOptIns();
    return hasMatchingRequestLoggingOptIn(optIns, params);
  } catch {
    return false;
  }
}
