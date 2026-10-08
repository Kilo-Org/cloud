import {
  AUTO_DECIDER_DEFAULT_MAX_COST_USD,
  AUTO_DECIDER_DEFAULT_MIN_COST_USD,
  AutoBenchmarkDeciderCandidatesResponseSchema,
  type BenchmarkPlatformModel,
} from '@kilocode/auto-routing-contracts';
import { mapConfigRows } from './config';
import { getConfigRows, replaceAutoDeciderModels, type ConfigAutoDeciderModelRow } from './db';
import {
  drainQueues,
  publishPlatformRoutingTable,
  sweepStaleRuns,
  syncPlatformRegistry,
  type StartedQueueRun,
} from './run';

type SyncOptions = {
  fetchImpl?: typeof fetch;
  now?: Date;
};

export type AutoDeciderSyncResult = {
  addedModels: string[];
  removedModels: string[];
  /** Registry entries the platform decider list wants after the sync. */
  platformEntries: number;
  /** Runs started for each queue this cycle (at most one per queue). */
  startedRuns: StartedQueueRun[];
  /** Version of the republished platform table, or null when nothing changed. */
  publishedVersion: string | null;
};

function diffModels(
  before: readonly BenchmarkPlatformModel[],
  after: readonly BenchmarkPlatformModel[]
): { added: string[]; removed: string[] } {
  const beforeIds = new Set(before.map(model => model.id));
  const afterIds = new Set(after.map(model => model.id));
  return {
    added: after.filter(model => !beforeIds.has(model.id)).map(model => model.id),
    removed: before.filter(model => !afterIds.has(model.id)).map(model => model.id),
  };
}

async function fetchAutoDeciderCandidates(
  env: Env,
  fetchImpl: typeof fetch,
  costBounds: { minCostUsd: number; maxCostUsd: number }
): Promise<{ id: string; avgAttemptCostUsd: number }[]> {
  const secret = await env.INTERNAL_API_SECRET_PROD.get();
  const url = new URL(
    '/api/internal/auto-routing-benchmark/decider-candidates',
    env.KILO_WEB_API_BASE_URL
  );
  url.searchParams.set('minCostUsd', String(costBounds.minCostUsd));
  url.searchParams.set('maxCostUsd', String(costBounds.maxCostUsd));
  const response = await fetchImpl(url.toString(), {
    headers: {
      authorization: `Bearer ${secret}`,
    },
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`auto decider candidate sync failed: HTTP ${response.status} ${detail}`);
  }
  const parsed = AutoBenchmarkDeciderCandidatesResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('auto decider candidate sync returned unexpected response');
  return parsed.data.candidates;
}

export async function syncAutoDeciderModels(
  env: Env,
  options: SyncOptions = {}
): Promise<AutoDeciderSyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const syncedAt = (options.now ?? new Date()).toISOString();

  await sweepStaleRuns(env);

  const beforeRows = await getConfigRows(env.BENCH_DB);
  const beforeConfig = mapConfigRows(
    beforeRows.config,
    beforeRows.classifierModels,
    beforeRows.deciderModels,
    beforeRows.autoDeciderModels,
    beforeRows.excludedAutoDeciderModels
  );

  const costBounds = {
    minCostUsd: beforeConfig?.autoDeciderMinCostUsd ?? AUTO_DECIDER_DEFAULT_MIN_COST_USD,
    maxCostUsd: beforeConfig?.autoDeciderMaxCostUsd ?? AUTO_DECIDER_DEFAULT_MAX_COST_USD,
  };
  const candidates = await fetchAutoDeciderCandidates(env, fetchImpl, costBounds);
  const nextAutoRows: ConfigAutoDeciderModelRow[] = candidates.map(candidate => ({
    model: candidate.id,
    reasoning_effort: null,
    avg_attempt_cost_usd: candidate.avgAttemptCostUsd,
    synced_at: syncedAt,
  }));

  await replaceAutoDeciderModels(env.BENCH_DB, nextAutoRows);

  const afterConfig = mapConfigRows(
    beforeRows.config,
    beforeRows.classifierModels,
    beforeRows.deciderModels,
    nextAutoRows,
    beforeRows.excludedAutoDeciderModels
  );
  const diff = diffModels(beforeConfig?.deciderModels ?? [], afterConfig?.deciderModels ?? []);

  // Reconcile the platform queue with the (possibly changed) decider list, then
  // drain both queues. Models that already have a ready registry row — measured
  // for an owner pool or by an earlier run — are reused, never re-benchmarked.
  const { desiredEntries } = await syncPlatformRegistry(env, fetchImpl);
  const startedRuns = await drainQueues(env, 'both');

  // Republish from the registry: a removed model must leave the live table even
  // when no new measurement was needed.
  const published = await publishPlatformRoutingTable(env, fetchImpl).catch(error => {
    console.warn(
      JSON.stringify({
        event: 'routing_table_publish_skipped',
        afterAutoDeciderSync: true,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return null;
  });

  return {
    addedModels: diff.added,
    removedModels: diff.removed,
    platformEntries: desiredEntries,
    startedRuns,
    publishedVersion: published?.version ?? null,
  };
}
