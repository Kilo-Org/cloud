import 'server-only';

import { ENKRYPT_API_KEY, ENKRYPT_SYNC_ENABLED } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { enkrypt_sync_state } from '@kilocode/db/schema';
import {
  ENKRYPT_STALE_AFTER_MS,
  EnkryptFailureCategorySchema,
  EnkryptSyncCountsSchema,
} from '@kilocode/db/schema-types';
import type { EnkryptFailureCategory, EnkryptSyncCounts } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import * as z from 'zod';

const TimestampSchema = z
  .string()
  .refine(value => Number.isFinite(Date.parse(value)))
  .transform(value => new Date(value).toISOString())
  .nullable();
const StateSchema = z.object({
  last_attempt_at: TimestampSchema,
  last_completed_at: TimestampSchema,
  last_success_at: TimestampSchema,
  last_outcome: z.enum(['running', 'succeeded', 'failed']).nullable(),
  last_failure_category: EnkryptFailureCategorySchema.nullable(),
  last_counts: EnkryptSyncCountsSchema.nullable(),
  last_success_counts: EnkryptSyncCountsSchema.nullable(),
  baseline_matched_count: z.number().int().nonnegative().nullable(),
});

export type EnkryptSyncHealthReason =
  | EnkryptFailureCategory
  | 'stale'
  | 'never_succeeded'
  | 'monitor_error';

export type EnkryptSyncHealth = {
  status: 'disabled' | 'healthy' | 'degraded' | 'stale' | 'never_succeeded' | 'unavailable';
  reason: EnkryptSyncHealthReason | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  counts: EnkryptSyncCounts | null;
  lastSuccessCounts: EnkryptSyncCounts | null;
  baselineMatchedCount: number | null;
};

function emptyHealth(
  status: EnkryptSyncHealth['status'],
  reason: EnkryptSyncHealthReason | null
): EnkryptSyncHealth {
  return {
    status,
    reason,
    lastAttemptAt: null,
    lastSuccessAt: null,
    counts: null,
    lastSuccessCounts: null,
    baselineMatchedCount: null,
  };
}

export async function getEnkryptSyncHealth(): Promise<EnkryptSyncHealth> {
  if (!ENKRYPT_SYNC_ENABLED) return emptyHealth('disabled', null);
  const configured = Boolean(ENKRYPT_API_KEY?.trim());
  try {
    const [row] = await db
      .select({
        last_attempt_at: enkrypt_sync_state.last_attempt_at,
        last_completed_at: enkrypt_sync_state.last_completed_at,
        last_success_at: enkrypt_sync_state.last_success_at,
        last_outcome: enkrypt_sync_state.last_outcome,
        last_failure_category: enkrypt_sync_state.last_failure_category,
        last_counts: enkrypt_sync_state.last_counts,
        last_success_counts: enkrypt_sync_state.last_success_counts,
        baseline_matched_count: enkrypt_sync_state.baseline_matched_count,
      })
      .from(enkrypt_sync_state)
      .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    if (!row) {
      return configured
        ? emptyHealth('never_succeeded', 'never_succeeded')
        : emptyHealth('degraded', 'configuration');
    }
    const now = Date.now();
    const parsed = StateSchema.safeParse(row);
    if (!parsed.success) return emptyHealth('unavailable', 'monitor_error');
    const state = parsed.data;
    if (
      [state.last_attempt_at, state.last_completed_at, state.last_success_at].some(
        value => value !== null && Date.parse(value) > now
      ) ||
      (state.last_success_at !== null &&
        (state.last_success_counts === null ||
          state.last_success_counts.matchedCount === 0 ||
          state.last_success_counts.updatedCount > state.last_success_counts.matchedCount ||
          state.last_success_counts.fetchedCount !==
            state.last_success_counts.rejectedCount +
              state.last_success_counts.matchedCount +
              state.last_success_counts.unmatchedCount +
              state.last_success_counts.ambiguousCount ||
          state.baseline_matched_count === null ||
          state.baseline_matched_count < state.last_success_counts.matchedCount)) ||
      (state.last_outcome === 'succeeded' && state.last_success_at === null) ||
      (state.last_outcome === 'failed' && state.last_failure_category === null)
    ) {
      return emptyHealth('unavailable', 'monitor_error');
    }

    let status: EnkryptSyncHealth['status'] = 'healthy';
    let reason: EnkryptSyncHealthReason | null = null;
    if (!configured) {
      status = 'degraded';
      reason = 'configuration';
    } else if (state.last_success_at === null) {
      status = state.last_outcome === 'failed' ? 'degraded' : 'never_succeeded';
      reason = state.last_outcome === 'failed' ? state.last_failure_category : 'never_succeeded';
    } else if (now - Date.parse(state.last_success_at) >= ENKRYPT_STALE_AFTER_MS) {
      status = 'stale';
      reason = 'stale';
    } else if (state.last_outcome === 'failed') {
      status = 'degraded';
      reason = state.last_failure_category;
    }
    return {
      status,
      reason,
      lastAttemptAt: state.last_attempt_at,
      lastSuccessAt: state.last_success_at,
      counts: state.last_counts,
      lastSuccessCounts: state.last_success_counts,
      baselineMatchedCount: state.baseline_matched_count,
    };
  } catch {
    return emptyHealth('unavailable', 'monitor_error');
  }
}
