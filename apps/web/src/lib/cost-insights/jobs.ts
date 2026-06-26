import type { CostInsightSpendOwner } from '@kilocode/db/cost-insights-rollups';

import { dispatchPendingCostInsightNotifications } from './notifications';
import {
  deleteExpiredCostInsightEvents,
  listEnabledCostInsightOwners,
  type CostInsightDatabase,
  type CostInsightRootDatabase,
} from './repository';
import { evaluateCostInsightsForOwner, processPendingCostInsightEvaluations } from './evaluation';

export type CostInsightHourlySweepSummary = {
  evaluatedOwners: number;
  failedOwners: Array<{ owner: CostInsightSpendOwner; error: string }>;
  dirtyEvaluations: Awaited<ReturnType<typeof processPendingCostInsightEvaluations>>;
  notifications: Awaited<ReturnType<typeof dispatchPendingCostInsightNotifications>>;
};

function ownerKey(owner: CostInsightSpendOwner): string {
  return `${owner.type}:${owner.id}`;
}

export async function runCostInsightHourlySweep(
  database: CostInsightRootDatabase,
  options: { asOf?: string; dirtyOwnerLimit?: number } = {}
): Promise<CostInsightHourlySweepSummary> {
  const asOf = options.asOf ?? new Date().toISOString();
  const dirtyEvaluations = await processPendingCostInsightEvaluations(database, {
    limit: options.dirtyOwnerLimit ?? 25,
    asOf,
    recoverCompletedHour: true,
  });
  const claimedOwnerKeys = new Set(
    [
      ...dirtyEvaluations.evaluatedOwners,
      ...dirtyEvaluations.failedOwners.map(row => row.owner),
    ].map(ownerKey)
  );
  const owners = (await listEnabledCostInsightOwners(database)).filter(
    owner => !claimedOwnerKeys.has(ownerKey(owner))
  );
  const failedOwners: CostInsightHourlySweepSummary['failedOwners'] = [
    ...dirtyEvaluations.failedOwners,
  ];
  let evaluatedOwners = dirtyEvaluations.evaluatedOwners.length;

  for (const owner of owners) {
    try {
      await evaluateCostInsightsForOwner(database, owner, {
        asOf,
        recoverCompletedHour: true,
      });
      evaluatedOwners += 1;
    } catch (error) {
      failedOwners.push({
        owner,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    evaluatedOwners,
    failedOwners,
    dirtyEvaluations,
    notifications: await dispatchPendingCostInsightNotifications(database),
  };
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
