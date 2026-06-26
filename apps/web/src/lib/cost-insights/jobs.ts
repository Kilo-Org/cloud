import type { CostInsightSpendOwner } from '@kilocode/db/cost-insights-rollups';

import { dispatchPendingCostInsightNotifications } from './notifications';
import {
  deleteExpiredCostInsightEvents,
  listEnabledCostInsightOwners,
  type CostInsightDatabase,
  type CostInsightRootDatabase,
} from './repository';
import { evaluateCostInsightsForOwner } from './evaluation';

export type CostInsightHourlySweepSummary = {
  evaluatedOwners: number;
  failedOwners: Array<{ owner: CostInsightSpendOwner; error: string }>;
  notifications: Awaited<ReturnType<typeof dispatchPendingCostInsightNotifications>>;
};

export async function runCostInsightHourlySweep(
  database: CostInsightRootDatabase
): Promise<CostInsightHourlySweepSummary> {
  const owners = await listEnabledCostInsightOwners(database);
  const failedOwners: CostInsightHourlySweepSummary['failedOwners'] = [];

  for (const owner of owners) {
    try {
      await evaluateCostInsightsForOwner(database, owner);
    } catch (error) {
      failedOwners.push({
        owner,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    evaluatedOwners: owners.length - failedOwners.length,
    failedOwners,
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
