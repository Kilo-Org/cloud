import {
  AUTO_DECIDER_DEFAULT_MAX_COST_USD,
  AUTO_DECIDER_DEFAULT_MIN_COST_USD,
  AutoBenchmarkDeciderCandidatesResponseSchema,
  type BenchmarkDeciderModel,
} from '@kilocode/auto-routing-contracts';
import { getBenchmarkConfig, mapConfigRows } from './config';
import { getConfigRows, replaceAutoDeciderModels, type ConfigAutoDeciderModelRow } from './db';
import { drainPendingProfileBatch, RunAlreadyActiveError, startRun, sweepStaleRuns } from './run';

type SyncOptions = {
  fetchImpl?: typeof fetch;
  now?: Date;
};

export type AutoDeciderSyncResult = {
  addedModels: string[];
  removedModels: string[];
  startedRun: boolean;
  runId: string | null;
  skippedReason?: 'active-run';
  activeRunId?: string;
  /** Profile batch started when no platform start claimed the free slot. */
  profileDrainRunId?: string | null;
};

function modelKey(model: BenchmarkDeciderModel): string {
  return `${model.id}\0${model.reasoningEffort ?? ''}`;
}

function diffModels(
  before: readonly BenchmarkDeciderModel[],
  after: readonly BenchmarkDeciderModel[]
): { added: string[]; removed: string[] } {
  const beforeKeys = new Set(before.map(modelKey));
  const afterKeys = new Set(after.map(modelKey));
  return {
    added: after.filter(model => !beforeKeys.has(modelKey(model))).map(model => model.id),
    removed: before.filter(model => !afterKeys.has(modelKey(model))).map(model => model.id),
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

async function tryDrainPendingProfiles(env: Env): Promise<string | null> {
  try {
    const drained = await drainPendingProfileBatch(env);
    return drained?.runId ?? null;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_profile_drain_error',
        afterAutoDeciderSync: true,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return null;
  }
}

export async function syncAutoDeciderModels(
  env: Env,
  options: SyncOptions = {}
): Promise<AutoDeciderSyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const syncedAt = (options.now ?? new Date()).toISOString();

  // Stale-run cleanup only — not a slot claim. Pending-profile drain is deferred
  // until after the platform-start decision so profile work never preempts a
  // free slot that scheduled platform start needs (plan change 6 / res #5).
  await sweepStaleRuns(env.BENCH_DB);

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
  const previousReasoningEffort = new Map<string, string | null>();
  for (const row of beforeRows.autoDeciderModels) {
    previousReasoningEffort.set(row.model, row.reasoning_effort);
  }
  for (const row of beforeRows.deciderModels) {
    previousReasoningEffort.set(row.model, row.reasoning_effort);
  }

  const nextAutoRows: ConfigAutoDeciderModelRow[] = candidates.map(candidate => ({
    model: candidate.id,
    reasoning_effort: previousReasoningEffort.get(candidate.id) ?? null,
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
  const changed = diff.added.length > 0 || diff.removed.length > 0;
  const hasConfig = Boolean(await getBenchmarkConfig(env.BENCH_DB));
  const platformStartNeeded = changed && hasConfig;

  if (!platformStartNeeded) {
    // No platform start this cycle → drain now so stranded pending work recovers.
    const profileDrainRunId = await tryDrainPendingProfiles(env);
    return {
      addedModels: diff.added,
      removedModels: diff.removed,
      startedRun: false,
      runId: null,
      profileDrainRunId,
    };
  }

  // Platform scheduled start takes the free slot first; profile work never
  // preempts. Occupied slot → log/skip that cycle (never fail job); leave
  // pending rows untouched (no drain while the slot is held).
  let run: Awaited<ReturnType<typeof startRun>>;
  try {
    run = await startRun(env, 'decider');
  } catch (error) {
    if (error instanceof RunAlreadyActiveError) {
      console.log(
        JSON.stringify({
          event: 'auto_decider_sync_skipped_active_run',
          activeRunId: error.activeRunId,
        })
      );
      return {
        addedModels: diff.added,
        removedModels: diff.removed,
        startedRun: false,
        runId: null,
        skippedReason: 'active-run',
        activeRunId: error.activeRunId,
        profileDrainRunId: null,
      };
    }
    throw error;
  }

  // Platform run claimed the slot. Do NOT drain this cycle — the run's terminal
  // transition (or a later cron with no platform start) drains pending work.
  return {
    addedModels: diff.added,
    removedModels: diff.removed,
    startedRun: true,
    runId: run.runId,
    profileDrainRunId: null,
  };
}
