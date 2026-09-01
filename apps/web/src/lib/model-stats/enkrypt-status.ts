import 'server-only';

import { ENKRYPT_API_KEY, ENKRYPT_SYNC_ENABLED } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { enkrypt_sync_state } from '@kilocode/db/schema';
import type { EnkryptSyncAlertReason } from '@kilocode/db/schema';
import {
  ENKRYPT_STALE_AFTER_MS,
  EnkryptFailureCategorySchema,
  EnkryptSyncCountsSchema,
} from '@kilocode/db/schema-types';
import type { EnkryptSyncCounts } from '@kilocode/db/schema-types';
import { eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import { EnkryptSyncError } from './enkrypt-errors';

const ALERT_SUPPRESSION_MS = 24 * 60 * 60 * 1000;
const AlertReasonSchema = z.union([
  EnkryptFailureCategorySchema,
  z.enum(['stale', 'never_succeeded', 'monitor_error']),
]);
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
  last_alert_at: TimestampSchema,
  last_alert_reason: AlertReasonSchema.nullable(),
});

export type EnkryptSyncHealth = {
  status: 'disabled' | 'healthy' | 'degraded' | 'stale' | 'never_succeeded' | 'unavailable';
  reason: EnkryptSyncAlertReason | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  counts: EnkryptSyncCounts | null;
  lastSuccessCounts: EnkryptSyncCounts | null;
  baselineMatchedCount: number | null;
  lastAlertAt: string | null;
  lastAlertReason: EnkryptSyncAlertReason | null;
  shouldAlert: boolean;
};

function emptyHealth(
  status: EnkryptSyncHealth['status'],
  reason: EnkryptSyncAlertReason | null,
  shouldAlert: boolean
): EnkryptSyncHealth {
  return {
    status,
    reason,
    lastAttemptAt: null,
    lastSuccessAt: null,
    counts: null,
    lastSuccessCounts: null,
    baselineMatchedCount: null,
    lastAlertAt: null,
    lastAlertReason: null,
    shouldAlert,
  };
}

function unavailableHealth(row: unknown, now: number): EnkryptSyncHealth {
  const health = emptyHealth('unavailable', 'monitor_error', true);
  const alerts = StateSchema.pick({ last_alert_at: true, last_alert_reason: true }).safeParse(row);
  if (!alerts.success) return health;
  const { last_alert_at: at, last_alert_reason: reason } = alerts.data;
  if (at !== null && Date.parse(at) > now) return health;
  return {
    ...health,
    lastAlertAt: at,
    lastAlertReason: reason,
    shouldAlert:
      reason !== 'monitor_error' || at === null || now - Date.parse(at) >= ALERT_SUPPRESSION_MS,
  };
}

export async function getEnkryptSyncHealth(): Promise<EnkryptSyncHealth> {
  if (!ENKRYPT_SYNC_ENABLED) return emptyHealth('disabled', null, false);
  const configured = Boolean(ENKRYPT_API_KEY?.trim());
  try {
    const [row] = await db
      .select()
      .from(enkrypt_sync_state)
      .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    if (!row) {
      return configured
        ? emptyHealth('never_succeeded', 'never_succeeded', true)
        : emptyHealth('degraded', 'configuration', true);
    }
    const now = Date.now();
    const parsed = StateSchema.safeParse(row);
    if (!parsed.success) return unavailableHealth(row, now);
    const state = parsed.data;
    if (
      [
        state.last_attempt_at,
        state.last_completed_at,
        state.last_success_at,
        state.last_alert_at,
      ].some(value => value !== null && Date.parse(value) > now) ||
      (state.last_success_at !== null &&
        (state.last_success_counts === null ||
          state.last_success_counts.updatedCount === 0 ||
          state.last_success_counts.updatedCount !== state.last_success_counts.matchedCount ||
          state.baseline_matched_count === null ||
          state.baseline_matched_count < state.last_success_counts.matchedCount)) ||
      (state.last_outcome === 'succeeded' && state.last_success_at === null) ||
      (state.last_outcome === 'failed' && state.last_failure_category === null)
    ) {
      return unavailableHealth(row, now);
    }

    let status: EnkryptSyncHealth['status'] = 'healthy';
    let reason: EnkryptSyncAlertReason | null = null;
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
    const recoveredSinceAlert =
      state.last_success_at !== null &&
      state.last_alert_at !== null &&
      Date.parse(state.last_success_at) > Date.parse(state.last_alert_at);
    return {
      status,
      reason,
      lastAttemptAt: state.last_attempt_at,
      lastSuccessAt: state.last_success_at,
      counts: state.last_counts,
      lastSuccessCounts: state.last_success_counts,
      baselineMatchedCount: state.baseline_matched_count,
      lastAlertAt: state.last_alert_at,
      lastAlertReason: state.last_alert_reason,
      shouldAlert:
        reason !== null &&
        (state.last_alert_reason !== reason ||
          state.last_alert_at === null ||
          recoveredSinceAlert ||
          now - Date.parse(state.last_alert_at) >= ALERT_SUPPRESSION_MS),
    };
  } catch {
    return emptyHealth('unavailable', 'monitor_error', true);
  }
}

export async function recordEnkryptSyncAlert(reason: string, at: string): Promise<void> {
  if (!ENKRYPT_SYNC_ENABLED) return;
  const parsedReason = AlertReasonSchema.safeParse(reason);
  const parsedAt = z.string().datetime().safeParse(at);
  if (!parsedReason.success || !parsedAt.success) throw new EnkryptSyncError('unexpected');
  const alertAt = new Date(parsedAt.data).toISOString();
  try {
    await db
      .insert(enkrypt_sync_state)
      .values({
        job_name: 'enkrypt',
        last_alert_at: alertAt,
        last_alert_reason: parsedReason.data,
      })
      .onConflictDoUpdate({
        target: enkrypt_sync_state.job_name,
        set: { last_alert_at: alertAt, last_alert_reason: parsedReason.data },
        setWhere: sql`(${enkrypt_sync_state.last_alert_at} IS NULL OR ${enkrypt_sync_state.last_alert_at} <= ${alertAt}::timestamptz) AND (${enkrypt_sync_state.last_success_at} IS NULL OR ${enkrypt_sync_state.last_success_at} < ${alertAt}::timestamptz)`,
      });
  } catch {
    throw new EnkryptSyncError('database');
  }
}
