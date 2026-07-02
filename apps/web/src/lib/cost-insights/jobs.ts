import type { CostInsightSpendOwner } from '@kilocode/db/cost-insights-rollups';
import { sql } from 'drizzle-orm';
import pLimit from 'p-limit';

import { evaluateCostInsightsForOwner, processPendingCostInsightEvaluations } from './evaluation';
import {
  acquireCostInsightHourlySweepLease,
  advanceCostInsightHourlySweepCursor,
  completeCostInsightHourlySweepCycle,
  releaseCostInsightHourlySweepLease,
} from './hourly-sweep-repository';
import { dispatchPendingCostInsightNotifications } from './notifications';
import {
  deleteExpiredCostInsightEvents,
  listEnabledCostInsightOwnerPage,
  type CostInsightDatabase,
  type CostInsightRootDatabase,
} from './repository';

const DEFAULT_SWEEP_TIME_BUDGET_MS = 240_000;
const OWNER_PAGE_SIZE = 20;
const OWNER_CONCURRENCY = 4;
const DIRTY_OWNER_LIMIT = 20;
const NOTIFICATION_LIMIT = 25;
const CHECKPOINT_LEASE_SECONDS = 5 * 60;

export type CostInsightHourlySweepSummary = {
  evaluatedOwners: number;
  failedOwners: Array<{ owner: CostInsightSpendOwner; error: string }>;
  dirtyEvaluations: Awaited<ReturnType<typeof processPendingCostInsightEvaluations>>;
  notifications: Awaited<ReturnType<typeof dispatchPendingCostInsightNotifications>>;
  dirtyQueueDepthBefore: number;
  dirtyQueueDepthAfter: number;
  evaluationDurationMs: number;
  rawCanonicalFallbackCount: number;
  rollupDegradedIntervalCount: number;
  alreadyRunning: boolean;
  deadlineReached: boolean;
  ownerCycleComplete: boolean;
  cycleId: string | null;
};

function ownerKey(owner: CostInsightSpendOwner): string {
  return `${owner.type}:${owner.id}`;
}

export async function runCostInsightHourlySweep(
  database: CostInsightRootDatabase,
  options: {
    asOf?: string;
    dirtyOwnerLimit?: number;
    timeBudgetMs?: number;
    ownerPageSize?: number;
    ownerConcurrency?: number;
    notificationLimit?: number;
  } = {}
): Promise<CostInsightHourlySweepSummary> {
  const asOf = options.asOf ?? new Date().toISOString();
  const deadline = performance.now() + (options.timeBudgetMs ?? DEFAULT_SWEEP_TIME_BUDGET_MS);
  const ownerConcurrency = options.ownerConcurrency ?? OWNER_CONCURRENCY;
  const dirtyQueueDepthBefore = await countCostInsightDirtyOwnerQueueDepth(database);
  const dirtyEvaluations = await processPendingCostInsightEvaluations(database, {
    limit: options.dirtyOwnerLimit ?? DIRTY_OWNER_LIMIT,
    asOf,
    recoverCompletedHour: true,
    concurrency: ownerConcurrency,
  });
  const claimedOwnerKeys = new Set(
    [
      ...dirtyEvaluations.evaluatedOwners,
      ...dirtyEvaluations.failedOwners.map(row => row.owner),
    ].map(ownerKey)
  );
  const failedOwners: CostInsightHourlySweepSummary['failedOwners'] = [
    ...dirtyEvaluations.failedOwners,
  ];
  let evaluatedOwners = dirtyEvaluations.evaluatedOwners.length;
  let evaluationDurationMs = dirtyEvaluations.evaluationDurationMs;
  let rawCanonicalFallbackCount = dirtyEvaluations.rawCanonicalFallbackCount;
  let rollupDegradedIntervalCount = dirtyEvaluations.rollupDegradedIntervalCount;
  let alreadyRunning = false;
  let deadlineReached = false;
  let ownerCycleComplete = false;
  let cycleId: string | null = null;

  const lease = await acquireCostInsightHourlySweepLease(database, {
    asOf,
    leaseSeconds: CHECKPOINT_LEASE_SECONDS,
  });
  if (!lease) {
    alreadyRunning = true;
  } else {
    cycleId = lease.cycleId;
    const limitOwnerWork = pLimit(ownerConcurrency);
    let cursor = lease.cursor;
    try {
      while (performance.now() < deadline) {
        const page = await listEnabledCostInsightOwnerPage(database, {
          cohortCreatedBefore: lease.cohortCreatedBefore,
          after: cursor,
          limit: options.ownerPageSize ?? OWNER_PAGE_SIZE,
        });
        if (page.owners.length === 0) {
          ownerCycleComplete = true;
          await completeCostInsightHourlySweepCycle(database, lease.leaseToken);
          break;
        }
        const outcomes = await Promise.all(
          page.owners.map(owner =>
            limitOwnerWork(async () => {
              if (claimedOwnerKeys.has(ownerKey(owner))) return { owner, skipped: true as const };
              try {
                const evaluation = await evaluateCostInsightsForOwner(database, owner, {
                  asOf: lease.cycleAsOf,
                  recoverCompletedHour: true,
                });
                return { owner, skipped: false as const, error: null, evaluation };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await markCostInsightOwnerDirtyForRetry(database, owner, message);
                return { owner, skipped: false as const, error: message, evaluation: null };
              }
            })
          )
        );
        for (const outcome of outcomes) {
          if (outcome.skipped) continue;
          if (outcome.error) {
            failedOwners.push({ owner: outcome.owner, error: outcome.error });
          } else {
            if (!outcome.evaluation) {
              throw new Error(
                'Cost Insights sweep evaluation summary missing for successful owner.'
              );
            }
            evaluatedOwners += 1;
            evaluationDurationMs += outcome.evaluation.durationMs;
            rawCanonicalFallbackCount += outcome.evaluation.rawCanonicalFallbackCount;
            rollupDegradedIntervalCount += outcome.evaluation.rollupDegradedIntervalCount;
          }
        }
        if (page.nextCursor) {
          await advanceCostInsightHourlySweepCursor(database, lease.leaseToken, page.nextCursor);
          cursor = page.nextCursor;
        }
        if (!page.hasMore) {
          ownerCycleComplete = true;
          await completeCostInsightHourlySweepCycle(database, lease.leaseToken);
          break;
        }
      }
      deadlineReached = !ownerCycleComplete && performance.now() >= deadline;
    } finally {
      if (!ownerCycleComplete) {
        await releaseCostInsightHourlySweepLease(database, lease.leaseToken);
      }
    }
  }

  return {
    evaluatedOwners,
    failedOwners,
    dirtyEvaluations,
    notifications: await dispatchPendingCostInsightNotifications(
      database,
      options.notificationLimit ?? NOTIFICATION_LIMIT
    ),
    dirtyQueueDepthBefore,
    dirtyQueueDepthAfter: await countCostInsightDirtyOwnerQueueDepth(database),
    evaluationDurationMs,
    rawCanonicalFallbackCount,
    rollupDegradedIntervalCount,
    alreadyRunning,
    deadlineReached,
    ownerCycleComplete,
    cycleId,
  };
}

async function countCostInsightDirtyOwnerQueueDepth(
  database: CostInsightRootDatabase
): Promise<number> {
  const result = await database.execute<{ count: string | number | bigint }>(sql`
    SELECT COUNT(*)::text AS count
    FROM cost_insight_evaluation_dirty_owners
  `);
  const value = Number(result.rows[0]?.count ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Cost Insights dirty-owner queue depth is outside the safe integer range.');
  }
  return value;
}

async function markCostInsightOwnerDirtyForRetry(
  database: CostInsightRootDatabase,
  owner: CostInsightSpendOwner,
  error: string
): Promise<void> {
  const ownerColumns =
    owner.type === 'user'
      ? { ownedByUserId: owner.id, ownedByOrganizationId: null }
      : { ownedByUserId: null, ownedByOrganizationId: owner.id };
  const conflictTarget =
    owner.type === 'user'
      ? sql.raw('(owned_by_user_id) WHERE owned_by_organization_id IS NULL')
      : sql.raw('(owned_by_organization_id) WHERE owned_by_user_id IS NULL');
  await database.execute(sql`
    INSERT INTO cost_insight_evaluation_dirty_owners AS dirty_owner (
      owned_by_user_id,
      owned_by_organization_id,
      dirty_at,
      next_attempt_at,
      last_error_redacted
    ) VALUES (
      ${ownerColumns.ownedByUserId},
      ${ownerColumns.ownedByOrganizationId},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP + INTERVAL '5 minutes',
      ${error.slice(0, 500)}
    )
    ON CONFLICT ${conflictTarget}
    DO UPDATE SET
      generation = dirty_owner.generation + 1,
      dirty_at = CURRENT_TIMESTAMP,
      next_attempt_at = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
      claimed_at = NULL,
      claim_token = NULL,
      last_error_redacted = ${error.slice(0, 500)},
      updated_at = CURRENT_TIMESTAMP
  `);
}

export async function runCostInsightEventRetentionCleanup(
  database: CostInsightDatabase
): Promise<{ deletedEvents: number; cutoff: string }> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  return {
    cutoff,
    deletedEvents: await deleteExpiredCostInsightEvents(database, cutoff),
  };
}
