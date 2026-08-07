import { classifyWithOpenRouter } from '@kilocode/auto-routing-contracts/classifier';
import {
  BENCHMARK_CONTAINER_BUDGET,
  CLASSIFIER_WINNER_KV_KEY,
  ROUTING_TABLE_KV_KEY,
  resolveBenchmarkIdentity,
  type BenchmarkConfig,
  type BenchmarkDeciderModel,
  type BenchmarkKind,
  type BenchmarkModelSummary,
  taxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import * as z from 'zod';
import { getBenchmarkConfig } from './config';
import { CLASSIFIER_CASES } from './datasets/classifier-cases';
import { DECIDER_CASES } from './datasets/decider-cases';
import type { RunModelRow, RunRow } from './db';
import {
  countCaseResultsByLane,
  countCurrentProfilesByStatus,
  exactPairKey,
  existsNewerCompletedRun,
  getCaseResults,
  getExistingCaseResultIds,
  getLatestSummariesByModel,
  getRunningRun,
  getRunWithModels,
  getLatestRoutingTable,
  getSummaries,
  getSummariesForRuns,
  insertRun,
  listLaneFailures,
  listPendingCurrentProfiles,
  listReadyCurrentProfilesForEntries,
  listStaleRunningDeciderRuns,
  markProfilesFailedForEntries,
  markProfilesFailedForRun,
  markProfilesReadyForRun,
  markProfilesRunningForRun,
  releaseProfileClaims,
  markRunCompleted,
  markRunFailed,
  markStaleRunsFailed,
  failOrphanedRunningProfiles,
  recordLaneFailure,
  replaceModelSummaries,
  saveRoutingTable,
  syncPlatformRegistryRows,
  upsertCaseResult,
  type BenchmarkRunPurpose,
  type CaseResultRow,
  type PriorModelResult,
} from './db';
import { gradeClassifierOutput, runDeciderCheck } from './grading';
import { createOpenRouterClient } from './openrouter';
import {
  buildRoutingTable,
  computeRegistryRoutingTableVersion,
  filterSummariesByProvenance,
} from './routing-table-builder';
import {
  destroyDeciderCliContainer,
  isRetryableContainerAvailabilityError,
  runDeciderCaseViaCli,
  warmUpCliContainer,
} from './cli-runner';
import {
  parsePersistedReasoningEffort,
  variantFromReasoningEffort,
  variantFromStorage,
  variantToStorage,
} from './reasoning-effort';
import { pickClassifierWinner } from './winner';

/** One exact Pool entry identity used throughout a decider/classifier run. */
export type RunModelEntry = {
  model: string;
  /** Canonical variant; null = default/no variant. */
  variant: string | null;
};

export type BenchmarkJobMessage = {
  runId: string;
  kind: BenchmarkKind;
  model: string;
  /** Exact-pair identity. Optional for backward-compatible old queue messages. */
  variant?: string | null;
  // The case ids this message is responsible for, plus the chunk index. Decider
  // chunks are split across shard lanes; each lane has one stable container.
  caseIds?: string[];
  chunk?: number;
  shard?: number;
  shardCount?: number;
  // Repetition index (0-based).
  rep?: number;
};

export const BenchmarkJobMessageSchema = z.object({
  runId: z.string().min(1),
  kind: z.enum(['classifier', 'decider']),
  model: z.string().min(1),
  variant: z.string().trim().min(1).nullable().optional(),
  caseIds: z.array(z.string().min(1)).optional(),
  chunk: z.number().int().min(0).optional(),
  shard: z.number().int().min(0).optional(),
  shardCount: z.number().int().min(1).optional(),
  rep: z.number().int().min(0).optional(),
});

// Decider cases run through the real `kilo` CLI in a container (up to ~3 min
// each). Chunking caps how many cases a single queue invocation processes so
// each stays well under CF's wall-clock limit.
const DECIDER_CHUNK_SIZE = 5;

// Classifier calls are OpenRouter HTTP requests. Some candidate models can take
// several minutes per request, so each queue invocation owns exactly one case to
// keep it below Cloudflare Queues' 15-minute wall-clock limit.
const CLASSIFIER_CHUNK_SIZE = 1;

// Cloudflare Queues caps a single sendBatch at 100 messages. Classifier fan-out
// can exceed that because each classifier case is its own message, so dispatch
// must be sliced.
const QUEUE_SEND_BATCH_LIMIT = 100;

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function computeDeciderShardCount({
  modelCount,
  repetitions,
  chunkCount,
  maxLiveContainers = BENCHMARK_CONTAINER_BUDGET,
}: {
  modelCount: number;
  repetitions: number;
  chunkCount: number;
  maxLiveContainers?: number;
}): number {
  if (modelCount <= 0 || repetitions <= 0 || chunkCount <= 0) return 0;
  const modelRepetitions = modelCount * repetitions;
  const shardsPerModelRepetition = Math.floor(maxLiveContainers / modelRepetitions);
  if (shardsPerModelRepetition <= 0) return 0;
  return Math.min(chunkCount, shardsPerModelRepetition);
}

// Enqueues messages in sendBatch-sized slices. A mid-dispatch failure leaves a
// partially-enqueued run that can never reach its expected result count, so the
// run is marked failed (surfacing in the admin panel) before the throw
// propagates to the POST handler.
async function enqueueRunMessages(
  env: Env,
  runId: string,
  messages: { body: BenchmarkJobMessage }[]
): Promise<void> {
  for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_LIMIT) {
    try {
      await env.BENCH_QUEUE.sendBatch(messages.slice(i, i + QUEUE_SEND_BATCH_LIMIT));
    } catch (error) {
      const reason = `enqueue failed after ${i} of ${messages.length} messages: ${formatError(error).error}`;
      await failRunAndDrain(env, runId, reason).catch(() => {});
      throw error;
    }
  }
}

/**
 * Mark a running run failed, fail the registry rows it claimed, then try to
 * drain both queues into whatever slot just freed up.
 */
export async function failRunAndDrain(env: Env, runId: string, error: string): Promise<void> {
  await markRunFailed(env.BENCH_DB, runId, error);
  try {
    await markProfilesFailedForRun(env.BENCH_DB, runId, error);
  } catch (profileError) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_profile_fail_transition_error',
        runId,
        ...formatError(profileError),
      })
    );
  }
  await drainQueues(env, 'both');
}

const STALE_RUN_MAX_AGE_MS = 6 * 3600_000;

// Fails any run still 'running' past the stale threshold (queue retries
// exhausted / dead-lettered). Called both before starting a run and when
// listing runs, so a wedged run is recovered without depending on a new run
// being started (the UI disables Start while a run shows 'running').
// Stale DECIDER runs are salvaged per entry first: entries whose lanes all
// produced results still become `ready`. Only entries with an unfinished lane
// fail, so one wedged model can't discard every other model's measurements —
// which matters because those measurements cost real money.
// Registry rows claimed by a stale run that could not be salvaged are failed so
// they do not stay stuck in `running`.
export async function sweepStaleRuns(env: Env): Promise<string[]> {
  const db = env.BENCH_DB;
  const olderThanIso = new Date(Date.now() - STALE_RUN_MAX_AGE_MS).toISOString();
  // Capture ids before the bulk status flip so profile claims can be settled.
  const stale = await listStaleRunningDeciderRuns(db, olderThanIso).catch(
    () => [] as Array<{ id: string; purpose: BenchmarkRunPurpose }>
  );
  for (const run of stale) {
    // Salvage before the bulk flip — markRunCompleted guards on status='running'.
    await salvageTimedOutDeciderRun(env, run.id).catch(error => {
      console.warn(
        JSON.stringify({
          event: 'benchmark_profile_salvage_error',
          runId: run.id,
          ...formatError(error),
        })
      );
    });
  }
  await markStaleRunsFailed(db, olderThanIso);
  // Rows a terminal run left claimed (its transition threw) are unreachable by
  // the drain, by requeue and by the stale sweep. Settle them so a pool entry
  // can never sit `running` forever.
  await failOrphanedRunningProfiles(db, PROFILE_ORPHANED_CLAIM_FAILURE_REASON, olderThanIso).catch(
    error => {
      console.warn(
        JSON.stringify({ event: 'benchmark_profile_orphan_release_error', ...formatError(error) })
      );
    }
  );
  for (const run of stale) {
    // No-ops for a salvaged run: its rows are already ready/failed.
    await markProfilesFailedForRun(db, run.id, 'timed out').catch(() => {});
  }
  return stale.map(run => run.id);
}

/**
 * Settle a timed-out decider run per entry. Every lane that never produced a
 * full set of case rows is recorded as failed, which lets the normal
 * finalization path complete the run: finished entries go `ready` with their
 * summaries, unfinished ones go `failed` and a requeue re-admits them.
 */
async function salvageTimedOutDeciderRun(env: Env, runId: string): Promise<void> {
  const state = await getRunState(env, runId);
  if (state.status !== 'running') return;

  const { unfinished, deadLaneKeys } = await loadLaneAccounting(
    env.BENCH_DB,
    runId,
    state,
    DECIDER_CASES.length
  );
  for (const lane of unfinished) {
    if (deadLaneKeys.has(laneKey(lane.model, lane.variant, lane.rep))) continue;
    await recordLaneFailure(env.BENCH_DB, { runId, ...lane, chunk: 0, shard: 0 });
  }
  console.warn(
    JSON.stringify({
      event: 'benchmark_decider_run_salvaged',
      runId,
      unfinishedLanes: unfinished.length,
    })
  );
  await finalizeRunIfComplete(env, runId, 'decider', state);
}

/**
 * Sweep stale runs, then drain both registry queues. Used by the scheduled
 * handler so a failed final queue message cannot strand pending work. Never
 * throws for drain/slot contention.
 */
export async function sweepStaleRunsAndDrain(env: Env): Promise<{
  staleRunIds: string[];
  drained: StartedQueueRun[];
}> {
  const staleRunIds = await sweepStaleRuns(env);
  const drained = await drainQueues(env, 'both');
  return { staleRunIds, drained };
}

export type StartedQueueRun = { runId: string; purpose: BenchmarkRunPurpose; entryCount: number };

/**
 * Drain the selected registry queues. 'both' starts at most one run per queue —
 * they hold independent slots and container budgets. Drain failures are logged
 * per queue, never thrown, so one wedged queue cannot block the other.
 */
export async function drainQueues(
  env: Env,
  selector: 'platform' | 'user' | 'both'
): Promise<StartedQueueRun[]> {
  const queues: BenchmarkRunPurpose[] =
    selector === 'both' ? ['platform', 'user'] : [selector satisfies BenchmarkRunPurpose];
  const started: StartedQueueRun[] = [];
  for (const queue of queues) {
    try {
      const drained = await drainQueue(env, queue);
      if (drained) started.push({ ...drained, purpose: queue });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'benchmark_queue_drain_error',
          queue,
          ...formatError(error),
        })
      );
    }
  }
  return started;
}

/**
 * Reconcile the platform queue with the saved decider model list. Every
 * configured exact pair ends up with a current-engine registry row; pairs that
 * already have a `ready` row (measured for an owner pool, or by an earlier
 * platform run) keep it and are not re-benchmarked.
 */
export async function syncPlatformRegistry(env: Env): Promise<{ desiredEntries: number }> {
  const config = await getBenchmarkConfig(env.BENCH_DB);
  if (!config) return { desiredEntries: 0 };
  const desired = platformRegistryEntries(config);
  await syncPlatformRegistryRows(
    env.BENCH_DB,
    { engineIdentity: computeEngineIdentity('decider'), repetitions: config.deciderRepetitions },
    desired
  );
  return { desiredEntries: desired.length };
}

/** The exact (model, variant) pairs the saved platform decider list wants. */
export function platformRegistryEntries(
  config: Pick<BenchmarkConfig, 'deciderModels'>
): RunModelEntry[] {
  return config.deciderModels.map(model => ({
    model: model.id,
    variant:
      model.variant !== undefined
        ? (model.variant ?? null)
        : variantFromReasoningEffort(model.reasoningEffort ?? null),
  }));
}

/**
 * Rebuild and publish the platform routing table from the registry. Candidates
 * come from ready+current registry rows for the configured platform pairs, each
 * bound to its own measuring run's summaries — the same provenance rule owner
 * pools use, so platform and user tables read the one shared measurement set.
 *
 * The table is published only once the platform queue has settled: no entry
 * still pending or running. Publishing mid-measurement would put a table built
 * from the handful of models measured so far in front of every user — after an
 * engine bump that can be a single model taking all routes. A permanently
 * failing model does not block publishing, because `failed` is settled.
 */
export async function publishPlatformRoutingTable(env: Env): Promise<{ version: string } | null> {
  const config = await getBenchmarkConfig(env.BENCH_DB);
  if (!config) return null;

  const current = {
    engineIdentity: computeEngineIdentity('decider'),
    repetitions: config.deciderRepetitions,
  };
  const desired = platformRegistryEntries(config);

  // syncPlatformRegistry flags exactly the desired pairs, so the platform queue
  // counts are this table's inputs.
  const queueCounts = await countCurrentProfilesByStatus(env.BENCH_DB, current, 'platform');
  const unsettled = queueCounts
    .filter(row => row.status === 'pending' || row.status === 'running')
    .reduce((total, row) => total + row.count, 0);
  if (unsettled > 0) {
    console.log(
      JSON.stringify({ event: 'routing_table_publish_skipped_queue_unsettled', unsettled })
    );
    return null;
  }

  const readyRows = await listReadyCurrentProfilesForEntries(env.BENCH_DB, current, desired);
  const readyEntries = readyRows
    .filter((row): row is typeof row & { run_id: string } => Boolean(row.run_id))
    .map(row => ({
      entry: { model: row.model, variant: variantFromStorage(row.variant) },
      runId: row.run_id,
    }));
  if (readyEntries.length === 0) {
    console.warn(JSON.stringify({ event: 'routing_table_publish_skipped_no_ready_entries' }));
    return null;
  }

  const summaries = await getSummariesForRuns(env.BENCH_DB, [
    ...new Set(readyEntries.map(r => r.runId)),
  ]);
  const generatedAt = new Date().toISOString();
  // Platform artifact keeps emitting reasoningEffort (not variant) so the shape
  // stays unchanged for auto-routing workers deployed before exact pairs.
  const deciderModels: BenchmarkDeciderModel[] = readyEntries.map(({ entry }) => ({
    id: entry.model,
    reasoningEffort: parsePersistedReasoningEffort(entry.variant),
  }));
  const table = buildRoutingTable({
    version: computeRegistryRoutingTableVersion(
      readyEntries.map(r => ({ runId: r.runId, model: r.entry.model, variant: r.entry.variant }))
    ),
    generatedAt,
    minAccuracy: config.minAccuracy,
    switchCostFactor: config.switchCostFactor,
    bestAccuracySwitchThreshold: config.bestAccuracySwitchThreshold,
    deciderModels,
    summaries: filterSummariesByProvenance(readyEntries, summaries),
  });

  // The version is a hash of the contributing registry rows, so an unchanged
  // registry republishes an identical table. Skip the write and the cache flush.
  const published = await getLatestRoutingTable(env.BENCH_DB).catch(() => null);
  if (published?.table.version === table.version) {
    return { version: table.version };
  }

  await saveRoutingTable(env.BENCH_DB, table, generatedAt);
  // Clear KV so the auto-routing worker repopulates from D1 on next request.
  await env.AUTO_ROUTING_CONFIG.delete(ROUTING_TABLE_KV_KEY);
  console.log(
    JSON.stringify({
      event: 'routing_table_published',
      version: table.version,
      readyEntries: readyEntries.length,
      desiredEntries: desired.length,
    })
  );
  return { version: table.version };
}

// Bump when grading logic, the CLI invocation/variant handling, the container
// image's pinned CLI, or any other execution input NOT captured by the dataset
// hash changes in a way that invalidates prior measurements. Forces every
// carried summary to be re-benchmarked on the next run.
const BENCHMARK_ENGINE_VERSION = 1;

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// Identifies the benchmark inputs that a run measured under, beyond the
// per-model reasoning_effort and run-level repetitions tracked separately:
// the dataset contents (ids + grading checks/expectations) and an engine
// version for code-level execution changes. Two runs sharing this identity
// (plus repetitions + reasoning_effort) produced comparable measurements, so a
// model's prior summaries can be carried instead of re-run.
export function computeEngineIdentity(kind: BenchmarkKind): string {
  const datasetSignature =
    kind === 'classifier'
      ? CLASSIFIER_CASES.map(c => ({ id: c.id, expected: c.expected }))
      : DECIDER_CASES.map(c => ({
          id: c.id,
          taskType: c.taskType,
          subtaskType: c.subtaskType,
          check: c.check,
        }));
  return `v${BENCHMARK_ENGINE_VERSION}:${fnv1aHex(JSON.stringify(datasetSignature))}`;
}

function normalizeRunModelEntries(models: readonly (string | RunModelEntry)[]): RunModelEntry[] {
  return models.map(entry => (typeof entry === 'string' ? { model: entry, variant: null } : entry));
}

/** Pure helper: produces the initial sendBatch bodies for a decider run.
 * Extracted for unit-testability; the shape is entries × reps messages. Later
 * chunks are chained by processDeciderJob after the previous chunk completes.
 * Accepts model id strings or exact `{ model, variant }` entries.
 */
export function buildDeciderMessages(
  runId: string,
  kind: BenchmarkKind,
  models: readonly (string | RunModelEntry)[],
  repetitions: number,
  chunks: readonly (readonly { id: string }[])[],
  maxLiveContainers: number = BENCHMARK_CONTAINER_BUDGET
): { body: BenchmarkJobMessage }[] {
  const entries = normalizeRunModelEntries(models);
  const shardCount = computeDeciderShardCount({
    modelCount: entries.length,
    repetitions,
    chunkCount: chunks.length,
    maxLiveContainers,
  });
  if (shardCount === 0) return [];
  return entries.flatMap(entry =>
    Array.from({ length: repetitions }, (_, rep) =>
      Array.from({ length: shardCount }, (_, shard) => {
        const chunkCases = chunks[shard];
        if (!chunkCases) return [];
        return [
          {
            body: {
              runId,
              kind,
              model: entry.model,
              variant: entry.variant,
              chunk: shard,
              shard,
              shardCount,
              rep,
              caseIds: chunkCases.map(c => c.id),
            } satisfies BenchmarkJobMessage,
          },
        ];
      }).flat()
    ).flat()
  );
}

export function getDeciderContainerInstanceName(
  message: Pick<BenchmarkJobMessage, 'runId' | 'model' | 'variant' | 'rep' | 'chunk' | 'shard'>
): string {
  // Include variant so two variants of one model in one run get distinct lanes.
  // Empty string for null keeps names stable and filesystem/DO-name safe.
  const variantPart = variantToStorage(message.variant);
  return `${message.runId}:${message.model}:${variantPart}:${message.rep ?? 0}:${message.shard ?? 0}`;
}

export function buildClassifierMessages(
  runId: string,
  models: readonly (string | RunModelEntry)[],
  repetitions: number,
  chunks: readonly (readonly { id: string }[])[]
): { body: BenchmarkJobMessage }[] {
  const entries = normalizeRunModelEntries(models);
  return entries.flatMap(entry =>
    Array.from({ length: repetitions }, (_, rep) =>
      chunks.map((chunkCases, chunk) => ({
        body: {
          runId,
          kind: 'classifier',
          model: entry.model,
          variant: entry.variant,
          chunk,
          rep,
          caseIds: chunkCases.map(c => c.id),
        } satisfies BenchmarkJobMessage,
      }))
    ).flat()
  );
}

// Thrown when a run of the same kind is already active. The admin route maps
// it to HTTP 409 so automated callers can distinguish it from a 5xx fault.
export class RunAlreadyActiveError extends Error {
  constructor(
    readonly kind: BenchmarkKind,
    readonly activeRunId: string
  ) {
    super(`a ${kind} benchmark run is already in progress (${activeRunId})`);
    this.name = 'RunAlreadyActiveError';
  }
}

/**
 * Thrown when every entry of a batch was already claimed by the other queue's
 * run. Not a fault: the pairs are being measured, just not by this run.
 */
export class NoEntriesClaimedError extends Error {
  constructor(readonly runId: string) {
    super(`no registry entries left to claim for ${runId}`);
    this.name = 'NoEntriesClaimedError';
  }
}

// Thrown when the saved benchmark config would exceed a hard runtime limit.
// The admin route maps it to HTTP 400 so operators can fix config instead of
// starting a run that will immediately hit platform capacity.
export class BenchmarkRunConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkRunConfigError';
  }
}

export function validateDeciderContainerBudget({
  modelCount,
  repetitions,
  maxLiveContainers,
}: {
  modelCount: number;
  repetitions: number;
  maxLiveContainers: number;
}): void {
  const modelRepetitions = modelCount * repetitions;
  if (modelRepetitions <= maxLiveContainers) return;

  throw new BenchmarkRunConfigError(
    `decider benchmark requires at least one live container lane per model repetition (${modelRepetitions}), but maxConcurrency is ${maxLiveContainers}; reduce decider models/repetitions before starting`
  );
}

export type StartRunOptions = {
  /** Classifier only: re-measure models that already have current results. */
  force?: boolean;
  /** Which registry queue this run drains. Classifier runs are always 'platform'. */
  purpose?: BenchmarkRunPurpose;
  /**
   * Registry entry snapshot to measure. Required for decider runs — every
   * decider measurement now comes from the registry queue, never from the saved
   * config list. Ignored for classifier runs.
   */
  entries?: readonly RunModelEntry[];
};

export async function startRun(
  env: Env,
  kind: BenchmarkKind,
  options: StartRunOptions = {}
): Promise<{ runId: string; enqueuedModels: number; skippedModels: string[] }> {
  const purpose: BenchmarkRunPurpose = options.purpose ?? 'platform';
  if (kind === 'decider' && (!options.entries || options.entries.length === 0)) {
    throw new BenchmarkRunConfigError('decider runs require a non-empty registry entry snapshot');
  }

  // Stale-run sweeper: fail dead 'running' runs first so a wedged run can't
  // block new ones and the admin panel shows the truth.
  await sweepStaleRuns(env);

  const config = await getBenchmarkConfig(env.BENCH_DB);
  if (!config) {
    throw new Error('benchmark config not set: save it in the admin panel before starting a run');
  }

  // One active run per (kind, purpose). The unique partial index is the atomic
  // backstop; this pre-check turns the common case (a run already going) into a
  // clean RunAlreadyActiveError instead of an insert-constraint failure.
  // The platform and user queues hold independent slots and can run at once.
  const activeRun = await getRunningRun(env.BENCH_DB, kind, purpose);
  if (activeRun) {
    throw new RunAlreadyActiveError(kind, activeRun.id);
  }
  const repetitions =
    kind === 'classifier' ? config.classifierRepetitions : config.deciderRepetitions;

  // Decider entries always come from the registry queue snapshot (which may
  // include two variants of one model). Classifier still measures its own list.
  const modelEntries: RunModelEntry[] =
    kind === 'decider'
      ? normalizeRunModelEntries(options.entries ?? [])
      : config.classifierModels.map(model => ({ model, variant: null }));

  const engineIdentity = computeEngineIdentity(kind);

  // Classifier entries with prior results are skipped (their latest summaries
  // are carried into this run's aggregate) unless the admin forces a re-run. A
  // prior result is only carried when it was measured under the SAME benchmark
  // identity — engine identity (dataset + grading version) and repetitions — so
  // a config/dataset change re-benchmarks instead of pairing current serving
  // config with stale numbers.
  // Decider runs never carry: the registry already dedupes across runs, and
  // registry provenance must point at a run that actually graded these entries.
  const priorByPair =
    options.force || kind === 'decider'
      ? new Map<string, PriorModelResult>()
      : await getLatestSummariesByModel(env.BENCH_DB, kind);
  const isCarryable = (entry: RunModelEntry): boolean => {
    const prior = priorByPair.get(exactPairKey(entry.model, entry.variant));
    return (
      prior !== undefined &&
      prior.engineIdentity === engineIdentity &&
      prior.repetitions === repetitions &&
      (prior.variant ?? null) === (entry.variant ?? null)
    );
  };
  const enqueuedEntries = modelEntries.filter(e => !isCarryable(e));
  const skippedEntries = modelEntries.filter(e => isCarryable(e));
  const skippedModels = skippedEntries.map(e => e.model);
  const carriedSummaries = skippedEntries.flatMap(
    e => priorByPair.get(exactPairKey(e.model, e.variant))?.summaries ?? []
  );

  const benchmarkIdentity = resolveBenchmarkIdentity(config);

  // Each queue owns its own lane budget so a running user-queue run never
  // shrinks a platform-queue run (and vice versa). The config schema keeps the
  // two budgets summing to at most the platform container cap.
  const laneBudget = purpose === 'user' ? config.userMaxConcurrency : config.maxConcurrency;
  if (kind === 'decider') {
    validateDeciderContainerBudget({
      modelCount: enqueuedEntries.length,
      repetitions,
      maxLiveContainers: laneBudget,
    });
  }

  const startedAt = new Date().toISOString();
  // Distinguish user-queue run ids so ops logs and D1 rows are easy to filter.
  const runId =
    purpose === 'user'
      ? `user-${startedAt.replace(/[:.]/g, '-')}`
      : `${kind}-${startedAt.replace(/[:.]/g, '-')}`;

  // Claim the registry rows BEFORE writing the run. Both queues drain from the
  // same registry and their drains can overlap (cron, admin, run completion), so
  // whichever claim lands first owns the pair; the loser drops it instead of
  // paying to benchmark it a second time and then discarding the result.
  let claimedEntries: RunModelEntry[] = modelEntries;
  if (kind === 'decider') {
    try {
      claimedEntries = await markProfilesRunningForRun(env.BENCH_DB, runId, modelEntries, {
        engineIdentity,
        repetitions,
      });
    } catch (error) {
      // The claim walks entries one statement at a time, so a failure part-way
      // leaves earlier rows claimed by a run that will never be written. Give
      // them straight back rather than leaving them for the orphan sweep.
      await releaseProfileClaims(env.BENCH_DB, runId).catch(releaseError => {
        console.warn(
          JSON.stringify({
            event: 'benchmark_profile_claim_release_error',
            runId,
            ...formatError(releaseError),
          })
        );
      });
      throw error;
    }
    if (claimedEntries.length === 0) {
      throw new NoEntriesClaimedError(runId);
    }
  }
  const claimedPairKeys = new Set(claimedEntries.map(e => exactPairKey(e.model, e.variant)));
  const runEntries = modelEntries.filter(e =>
    claimedPairKeys.has(exactPairKey(e.model, e.variant))
  );
  const enqueuedRunEntries = enqueuedEntries.filter(e =>
    claimedPairKeys.has(exactPairKey(e.model, e.variant))
  );

  // Build run_models rows for ALL exact entries of this run. reasoning_effort is
  // a legacy mirror of the variant, kept for provenance and rollback.
  const enqueuedPairKeys = new Set(enqueuedRunEntries.map(e => exactPairKey(e.model, e.variant)));
  const runModelRows: RunModelRow[] = runEntries.map(entry => ({
    run_id: runId,
    model: entry.model,
    variant: variantToStorage(entry.variant),
    enqueued: enqueuedPairKeys.has(exactPairKey(entry.model, entry.variant)),
    reasoning_effort: entry.variant,
  }));

  try {
    await insertRun(
      env.BENCH_DB,
      {
        id: runId,
        kind,
        startedAt,
        min_accuracy: config.minAccuracy,
        switch_cost_factor: config.switchCostFactor,
        best_accuracy_switch_threshold: config.bestAccuracySwitchThreshold,
        max_concurrency: laneBudget,
        benchmark_user_id: benchmarkIdentity.benchmarkUserId,
        benchmark_org_id: benchmarkIdentity.benchmarkOrgId,
        repetitions,
        classifier_max_p95_latency_ms:
          kind === 'classifier' ? config.classifierMaxP95LatencyMs : null,
        engine_identity: engineIdentity,
        purpose,
      },
      runModelRows,
      carriedSummaries
    );
  } catch (error) {
    // The claim is already made, so hand the rows back to the queue — otherwise
    // they sit `running` under a run that was never written and nothing can
    // reach them.
    if (kind === 'decider') {
      await releaseProfileClaims(env.BENCH_DB, runId).catch((releaseError: unknown) => {
        console.warn(
          JSON.stringify({
            event: 'benchmark_profile_claim_release_error',
            runId,
            ...formatError(releaseError),
          })
        );
      });
    }
    // The pre-check already passed, so an insert failure is almost certainly a
    // race losing the one-running-per-slot unique index. Re-read the winner and
    // surface a clean conflict rather than a 500.
    const winner = await getRunningRun(env.BENCH_DB, kind, purpose).catch(() => undefined);
    if (winner && winner.id !== runId) {
      throw new RunAlreadyActiveError(kind, winner.id);
    }
    throw error;
  }

  console.log(
    JSON.stringify({
      event: 'benchmark_run_started',
      runId,
      kind,
      purpose,
      enqueuedModels: enqueuedRunEntries.map(e => e.model),
      skippedModels,
    })
  );

  if (enqueuedRunEntries.length === 0) {
    // Everything already has results: complete immediately and republish the
    // aggregate so config-only changes (model removed, threshold tweaked)
    // take effect without re-running any model. The state mirrors the rows
    // insertRun just wrote, so no re-read is needed.
    await finalizeRunIfComplete(env, runId, kind, {
      status: 'running',
      maxConcurrency: laneBudget,
      minAccuracy: config.minAccuracy,
      switchCostFactor: config.switchCostFactor,
      bestAccuracySwitchThreshold: config.bestAccuracySwitchThreshold,
      benchmarkUserId: benchmarkIdentity.benchmarkUserId,
      benchmarkOrgId: benchmarkIdentity.benchmarkOrgId,
      models: runModelRows,
      repetitions,
      classifierMaxP95LatencyMs: kind === 'classifier' ? config.classifierMaxP95LatencyMs : null,
      startedAt,
      purpose,
    });
    return { runId, enqueuedModels: 0, skippedModels };
  }

  if (kind === 'classifier') {
    const chunks = chunkArray(CLASSIFIER_CASES, CLASSIFIER_CHUNK_SIZE);
    const messages = buildClassifierMessages(runId, enqueuedRunEntries, repetitions, chunks);
    await enqueueRunMessages(env, runId, messages);
    return { runId, enqueuedModels: enqueuedRunEntries.length, skippedModels };
  }

  // Decider: seed as many shard lanes as fit under the live-container cap. Each
  // completed chunk enqueues the next chunk for the same lane, so one stable
  // container handles chunk N, N+shardCount, N+(2*shardCount), ...
  const chunks = chunkArray(DECIDER_CASES, DECIDER_CHUNK_SIZE);
  const messages = buildDeciderMessages(
    runId,
    kind,
    enqueuedRunEntries,
    repetitions,
    chunks,
    laneBudget
  );
  await enqueueRunMessages(env, runId, messages);
  return { runId, enqueuedModels: enqueuedRunEntries.length, skippedModels };
}

/**
 * Claim the oldest pending registry batch of one queue that fits that queue's
 * container budget, and start a run for it. Runs on a timer, on the admin's
 * manual trigger, and after any decider run reaches a terminal state. No-ops
 * when that queue's slot is occupied or there is no pending work. The other
 * queue's state is irrelevant — the slots and budgets are independent.
 * Returns the started run id, or null.
 */
export async function drainQueue(
  env: Env,
  queue: BenchmarkRunPurpose
): Promise<{ runId: string; entryCount: number } | null> {
  const config = await getBenchmarkConfig(env.BENCH_DB);
  if (!config) return null;

  const active = await getRunningRun(env.BENCH_DB, 'decider', queue);
  if (active) {
    console.log(
      JSON.stringify({
        event: 'benchmark_queue_drain_skipped_slot_occupied',
        queue,
        activeRunId: active.id,
      })
    );
    return null;
  }

  const engineIdentity = computeEngineIdentity('decider');
  const repetitions = config.deciderRepetitions;
  const pending = await listPendingCurrentProfiles(
    env.BENCH_DB,
    { engineIdentity, repetitions },
    queue
  );
  if (pending.length === 0) return null;

  // Oldest-first (query already ordered by requested_at). Cap by this queue's
  // container budget: modelCount * repetitions <= maxLiveContainers.
  const maxLive = queue === 'user' ? config.userMaxConcurrency : config.maxConcurrency;
  const maxEntries = Math.max(1, Math.floor(maxLive / Math.max(1, repetitions)));
  const batch = pending.slice(0, maxEntries);
  const entries: RunModelEntry[] = batch.map(row => ({
    model: row.model,
    variant: variantFromStorage(row.variant),
  }));

  try {
    const result = await startRun(env, 'decider', { purpose: queue, entries });
    console.log(
      JSON.stringify({
        event: 'benchmark_queue_drain_started',
        queue,
        runId: result.runId,
        entryCount: entries.length,
        models: entries.map(e => e.model),
      })
    );
    return { runId: result.runId, entryCount: entries.length };
  } catch (error) {
    if (error instanceof RunAlreadyActiveError) {
      console.log(
        JSON.stringify({
          event: 'benchmark_queue_drain_skipped_slot_occupied',
          queue,
          activeRunId: error.activeRunId,
        })
      );
      return null;
    }
    if (error instanceof NoEntriesClaimedError) {
      // The other queue claimed this whole batch between our read and our
      // claim. The pairs are being measured; nothing to do.
      console.log(JSON.stringify({ event: 'benchmark_queue_drain_batch_already_claimed', queue }));
      return null;
    }
    throw error;
  }
}

export async function processJob(env: Env, rawMessage: unknown): Promise<void> {
  // Validate the message shape; malformed messages are logged and dropped
  // rather than retried forever.
  const parsed = BenchmarkJobMessageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_job_invalid_message',
        error: parsed.error.message,
        raw: JSON.stringify(rawMessage).slice(0, 200),
      })
    );
    return;
  }

  const message = parsed.data;
  const state = await getRunState(env, message.runId);

  let shouldFinalize = true;
  if (message.kind === 'classifier') {
    if (!message.caseIds?.length || message.rep === undefined) {
      console.warn(
        JSON.stringify({
          event: 'benchmark_classifier_job_missing_chunk',
          runId: message.runId,
          model: message.model,
        })
      );
      return;
    }

    // Create the OpenRouter client inside processJob — no module-scope transport clients.
    const client = await createOpenRouterClient(env);
    const caseIds = new Set(message.caseIds);
    const rep = message.rep;
    const expandedItems = CLASSIFIER_CASES.filter(benchCase => caseIds.has(benchCase.id)).map(
      benchCase => ({ benchCase, rep })
    );
    const classifierVariant = variantToStorage(message.variant);
    await runCasesWithConcurrency(
      expandedItems,
      state.maxConcurrency,
      async ({ benchCase, rep }) => {
        const startedAt = performance.now();
        try {
          const result = await classifyWithOpenRouter(client, benchCase.input, message.model);
          const score = result.fallback
            ? 0
            : gradeClassifierOutput(benchCase.expected, result.classification);
          await upsertCaseResult(env.BENCH_DB, {
            run_id: message.runId,
            model: message.model,
            variant: classifierVariant,
            case_id: benchCase.id,
            route_key: null,
            score,
            latency_ms: Math.round(performance.now() - startedAt),
            cost_usd: result.cost,
            error: null,
            fallback_reason: result.fallback?.reason ?? null,
            retried: result.retried ?? false,
            exit_code: null,
            output_prefix: null,
            event_count: null,
            last_event_types: null,
            rep,
            timed_out: 0,
          });
        } catch (error) {
          await upsertCaseResult(
            env.BENCH_DB,
            failedRow(message, benchCase.id, null, startedAt, error, rep)
          );
        }
      }
    );
  } else {
    const result = await processDeciderJob(env, message, state);
    shouldFinalize = result.shouldFinalize;
  }

  if (shouldFinalize) {
    await finalizeRunIfComplete(env, message.runId, message.kind, state);
  }
}

/**
 * Handle a dead-lettered benchmark job: record the lane death, then attempt
 * finalization so a single dead lane cannot wedge its run. Malformed messages
 * and terminal runs are settled cases and return normally; transient failures
 * (e.g. D1) throw so the DLQ consumer retries — a death recorded without a
 * completed finalization must be re-attempted, not acked away.
 */
export async function processDeadLetter(env: Env, rawMessage: unknown): Promise<void> {
  const parsed = BenchmarkJobMessageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_deadletter_invalid_message',
        error: parsed.error.message,
        raw: JSON.stringify(rawMessage).slice(0, 200),
      })
    );
    return;
  }

  const message = parsed.data;
  const state = await getRunState(env, message.runId).catch(() => undefined);
  if (!state || state.status !== 'running') {
    // Run already completed/failed/swept — its lane accounting is settled.
    console.warn(
      JSON.stringify({ event: 'benchmark_deadletter_run_not_running', runId: message.runId })
    );
    return;
  }

  // Resolve the exact-pair variant like processDeciderJob does: an explicit
  // message variant wins; a legacy variant-less message maps to the model's
  // sole snapshot row.
  const rowsForModel = state.models.filter(m => m.model === message.model);
  const soleVariant = rowsForModel.length === 1 ? rowsForModel[0]?.variant : undefined;
  const storedVariant =
    message.variant !== undefined
      ? variantToStorage(message.variant)
      : (soleVariant ?? variantToStorage(null));

  await recordLaneFailure(env.BENCH_DB, {
    runId: message.runId,
    model: message.model,
    variant: storedVariant,
    rep: message.rep ?? 0,
    chunk: message.chunk ?? 0,
    shard: message.shard ?? 0,
  });
  console.warn(
    JSON.stringify({
      event: 'benchmark_lane_dead',
      runId: message.runId,
      kind: message.kind,
      model: message.model,
      variant: variantFromStorage(storedVariant),
      rep: message.rep ?? 0,
      chunk: message.chunk ?? 0,
    })
  );
  await finalizeRunIfComplete(env, message.runId, message.kind, state);
}

type RunState = {
  status: RunRow['status'];
  maxConcurrency: number;
  minAccuracy: number;
  switchCostFactor: number;
  bestAccuracySwitchThreshold: number;
  benchmarkUserId: string | null;
  benchmarkOrgId: string | null;
  models: RunModelRow[];
  repetitions: number;
  classifierMaxP95LatencyMs: number | null;
  startedAt: string;
  purpose: BenchmarkRunPurpose;
};

async function getRunState(env: Env, runId: string): Promise<RunState> {
  // Snapshots taken at startRun time so a mid-run admin edit can't skew them.
  const result = await getRunWithModels(env.BENCH_DB, runId);
  if (!result) throw new Error(`unknown run ${runId}`);
  const { run, models } = result;
  return {
    status: run.status,
    maxConcurrency: run.max_concurrency,
    minAccuracy: run.min_accuracy,
    switchCostFactor: run.switch_cost_factor,
    bestAccuracySwitchThreshold: run.best_accuracy_switch_threshold,
    benchmarkUserId: run.benchmark_user_id,
    benchmarkOrgId: run.benchmark_org_id,
    models,
    repetitions: run.repetitions,
    classifierMaxP95LatencyMs: run.classifier_max_p95_latency_ms,
    startedAt: run.started_at,
    purpose: run.purpose === 'user' ? 'user' : 'platform',
  };
}

async function processDeciderJob(
  env: Env,
  message: BenchmarkJobMessage,
  state: RunState
): Promise<{ shouldFinalize: boolean }> {
  // Decider messages always carry their chunk's case ids; anything else is
  // malformed and dropped (same policy as unparseable messages).
  if (!message.caseIds?.length) {
    console.warn(JSON.stringify({ event: 'benchmark_job_missing_case_ids', runId: message.runId }));
    return { shouldFinalize: false };
  }
  const caseIds = new Set(message.caseIds);
  const cases = DECIDER_CASES.filter(c => caseIds.has(c.id));
  if (cases.length === 0) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_job_empty_case_chunk',
        runId: message.runId,
        model: message.model,
        chunk: message.chunk ?? 0,
      })
    );
    return { shouldFinalize: false };
  }

  if (!state.benchmarkUserId) {
    // startRun snapshots the effective default/override identity, so this only
    // happens if the run row was tampered with; throwing lets the queue retry.
    throw new Error(`run ${message.runId} has no benchmarkUserId`);
  }

  const rep = message.rep ?? 0;
  const chunk = message.chunk ?? 0;
  const shard = message.shard ?? 0;
  const shardCount = message.shardCount ?? 1;

  // Resolve the run-snapshot row for this message's exact pair.
  // - Explicit message.variant (including null): require exact (model, variant).
  //   A missing pair is corrupt — throw so the queue retries then dead-letters;
  //   never grade with a CLI variant taken from a non-matching row.
  // - Legacy pre-deploy messages (variant undefined): model-only fallback only
  //   when the snapshot has exactly one row for that model; otherwise throw.
  const modelRowsForModel = state.models.filter(m => m.model === message.model);
  let modelRow: RunModelRow;
  if (message.variant !== undefined) {
    const messageVariant = message.variant ?? null;
    const exact = modelRowsForModel.find(m => variantFromStorage(m.variant) === messageVariant);
    if (!exact) {
      throw new Error(
        `run ${message.runId} has no snapshot row for model ${message.model} variant ${JSON.stringify(messageVariant)}`
      );
    }
    modelRow = exact;
  } else {
    const sole = modelRowsForModel.length === 1 ? modelRowsForModel[0] : undefined;
    if (!sole) {
      throw new Error(
        `run ${message.runId}: legacy decider message for model ${message.model} requires exactly one snapshot row, found ${modelRowsForModel.length}`
      );
    }
    modelRow = sole;
  }
  const entryVariant =
    message.variant !== undefined
      ? (message.variant ?? null)
      : variantFromStorage(modelRow.variant);
  const storedVariant = variantToStorage(entryVariant);
  // Canonical variant passed to the CLI — derived only from the resolved pair.
  const cliVariant = entryVariant ?? modelRow.reasoning_effort ?? null;

  const instanceName = getDeciderContainerInstanceName({
    ...message,
    variant: entryVariant,
  });

  const existingCaseIds = await getExistingCaseResultIds(env.BENCH_DB, {
    runId: message.runId,
    model: message.model,
    variant: entryVariant,
    rep,
    caseIds: cases.map(c => c.id),
  });
  const casesToRun = cases.filter(c => !existingCaseIds.has(c.id));

  if (casesToRun.length > 0) {
    // Fetch a short-lived user token ONCE per queue message. Non-OK throws so the
    // queue retries the message. The token is never logged.
    const kiloToken = await fetchBenchmarkUserToken(
      env,
      state.benchmarkUserId,
      state.benchmarkOrgId
    );

    // Fresh container instances run the CLI's one-time sqlite migration; the
    // container owns that via its /warmup endpoint so the first real case
    // doesn't burn its timeout on it. Ordinary warmup failures are non-fatal:
    // the first case absorbs whatever warmup work remains. Container capacity
    // failures are infrastructure pressure, so the queue retries the message.
    await warmUpCliContainer(env, {
      instanceName,
      model: message.model,
      kiloToken,
      kiloApiUrl: env.KILO_CLI_API_URL,
      orgId: state.benchmarkOrgId,
    }).catch(error => {
      if (isRetryableContainerAvailabilityError(error)) throw error;
    });

    // Concurrency 1: the CLI's sqlite state in the container is not safe under
    // concurrent sessions (partial-migration crashes); the container serializes
    // too, so higher concurrency here would only hold HTTP requests open.
    await runCasesWithConcurrency(casesToRun, 1, async benchCase => {
      const startedAt = performance.now();
      try {
        let result = await runDeciderCaseViaCli(env, {
          instanceName,
          model: message.model,
          benchCase,
          kiloToken,
          kiloApiUrl: env.KILO_CLI_API_URL,
          orgId: state.benchmarkOrgId,
          variant: cliVariant,
        });
        // The CLI occasionally ends a session with no assistant text at all
        // (transient empty completion: a lone step_finish with cost 0). Mirror
        // the production classifier's policy and retry once.
        let retried = false;
        if (result.exitCode === 0 && result.text.length === 0) {
          retried = true;
          const retry = await runDeciderCaseViaCli(env, {
            instanceName,
            model: message.model,
            benchCase,
            kiloToken,
            kiloApiUrl: env.KILO_CLI_API_URL,
            orgId: state.benchmarkOrgId,
            variant: cliVariant,
          });
          retry.costUsd =
            retry.costUsd === null && result.costUsd === null
              ? null
              : (retry.costUsd ?? 0) + (result.costUsd ?? 0);
          result = retry;
        }
        const succeeded =
          result.exitCode === 0 &&
          result.text.length > 0 &&
          runDeciderCheck(benchCase.check, result.text);
        await upsertCaseResult(env.BENCH_DB, {
          run_id: message.runId,
          model: message.model,
          variant: storedVariant,
          case_id: benchCase.id,
          route_key: taxonomyRouteKey(benchCase),
          score: succeeded ? 1 : 0,
          latency_ms: result.latencyMs,
          cost_usd: result.costUsd,
          error: result.exitCode !== 0 ? result.stderrTail.slice(0, 500) : null,
          fallback_reason: null,
          retried,
          exit_code: result.exitCode,
          output_prefix: result.text.slice(0, 200),
          event_count: result.eventCount,
          last_event_types: result.lastEventTypes.join(' '),
          rep,
          timed_out: result.timedOut ? 1 : 0,
        });
      } catch (error) {
        if (isRetryableContainerAvailabilityError(error)) throw error;
        await upsertCaseResult(
          env.BENCH_DB,
          failedRow(
            { ...message, variant: entryVariant },
            benchCase.id,
            taxonomyRouteKey(benchCase),
            startedAt,
            error,
            rep
          )
        );
      }
    });
  }

  const hasNextChunk = await enqueueNextDeciderChunkIfNeeded(
    env,
    { ...message, variant: entryVariant },
    rep,
    chunk,
    shard,
    shardCount
  );
  if (!hasNextChunk) {
    await destroyDeciderCliContainer(env, { instanceName }).catch(error => {
      console.warn(
        JSON.stringify({
          event: 'benchmark_container_destroy_failed',
          instanceName,
          ...formatError(error),
        })
      );
    });
  }
  return { shouldFinalize: !hasNextChunk };
}

async function enqueueNextDeciderChunkIfNeeded(
  env: Env,
  message: BenchmarkJobMessage,
  rep: number,
  chunk: number,
  shard: number,
  shardCount: number
): Promise<boolean> {
  const chunks = chunkArray(DECIDER_CASES, DECIDER_CHUNK_SIZE);
  const nextChunkIndex = chunk + shardCount;
  const nextChunk = chunks[nextChunkIndex];
  if (!nextChunk) return false;

  const nextCaseIds = nextChunk.map(c => c.id);
  const existingNextCaseIds = await getExistingCaseResultIds(env.BENCH_DB, {
    runId: message.runId,
    model: message.model,
    variant: message.variant ?? null,
    rep,
    caseIds: nextCaseIds,
  });
  if (existingNextCaseIds.size >= nextCaseIds.length) return true;

  await env.BENCH_QUEUE.sendBatch([
    {
      body: {
        runId: message.runId,
        kind: 'decider',
        model: message.model,
        variant: message.variant ?? null,
        chunk: nextChunkIndex,
        shard,
        shardCount,
        rep,
        caseIds: nextCaseIds,
      } satisfies BenchmarkJobMessage,
    },
  ]);
  return true;
}

const TokenResponseSchema = z.object({ token: z.string().min(1), expiresAt: z.string() });

// Calls apps/web's internal endpoint to mint a short-lived user API token for
// the decider CLI. Never logs the token.
export async function fetchBenchmarkUserToken(
  env: Env,
  userId: string,
  organizationId: string | null = null
): Promise<string> {
  const secret = await env.INTERNAL_API_SECRET_PROD.get();
  const response = await fetch(
    `${env.KILO_WEB_API_BASE_URL}/api/internal/auto-routing-benchmark/token`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ userId, ...(organizationId ? { organizationId } : {}) }),
    }
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`token mint failed: HTTP ${response.status} ${detail}`);
  }
  const parsedToken = TokenResponseSchema.safeParse(await response.json());
  if (!parsedToken.success) {
    throw new Error('token mint returned unexpected response shape');
  }
  return parsedToken.data.token;
}

function failedRow(
  message: BenchmarkJobMessage,
  caseId: string,
  routeKey: string | null,
  startedAt: number,
  error: unknown,
  rep: number = 0
): CaseResultRow {
  return {
    run_id: message.runId,
    model: message.model,
    variant: variantToStorage(message.variant),
    case_id: caseId,
    route_key: routeKey,
    score: 0,
    latency_ms: Math.round(performance.now() - startedAt),
    cost_usd: null,
    error: JSON.stringify(formatError(error)).slice(0, 500),
    fallback_reason: null,
    retried: null,
    exit_code: null,
    output_prefix: null,
    event_count: null,
    last_event_types: null,
    rep,
    timed_out: 0,
  };
}

export async function runCasesWithConcurrency<T>(
  cases: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...cases];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// Lane identity for completion accounting: one (model, variant, rep) chain of
// chunk messages. JSON tuple keys (storage-form variant) so model/variant
// values can never collide across concatenation.
function laneKey(model: string, variant: string, rep: number): string {
  return JSON.stringify([model, variant, rep]);
}

/** Failure reason for rows a terminal run left claimed. */
export const PROFILE_ORPHANED_CLAIM_FAILURE_REASON =
  'Benchmark run ended without settling this entry; requeue to re-measure.';

/** Failure reason written to profile entries whose lane never finished. */
export const PROFILE_LANE_DEAD_FAILURE_REASON =
  'Benchmark lane did not finish (queue retries exhausted or run timed out); retry to re-measure.';

type Lane = { model: string; variant: string; rep: number };

/**
 * Lane accounting for a run: a lane is done when all its case rows exist, dead
 * when one of its chunk messages dead-lettered (rows win — a message can die
 * after its writes landed). `unfinished` is every lane without a full set of
 * rows; the caller decides whether an unfinished lane is fatal or just missing.
 */
async function loadLaneAccounting(
  db: D1Database,
  runId: string,
  state: RunState,
  caseCount: number
): Promise<{ unfinished: Lane[]; deadLaneKeys: Set<string> }> {
  const [laneCounts, laneFailures] = await Promise.all([
    countCaseResultsByLane(db, runId),
    listLaneFailures(db, runId),
  ]);
  const countByLane = new Map(laneCounts.map(r => [laneKey(r.model, r.variant, r.rep), r.n]));
  const lanes: Lane[] = state.models
    .filter(m => m.enqueued)
    .flatMap(m =>
      Array.from({ length: state.repetitions }, (_, rep) => ({
        model: m.model,
        variant: m.variant,
        rep,
      }))
    );
  return {
    unfinished: lanes.filter(
      lane => (countByLane.get(laneKey(lane.model, lane.variant, lane.rep)) ?? 0) < caseCount
    ),
    deadLaneKeys: new Set(laneFailures.map(f => laneKey(f.model, f.variant, f.rep))),
  };
}

async function finalizeRunIfComplete(
  env: Env,
  runId: string,
  kind: BenchmarkKind,
  // Run snapshot already loaded by the caller (startRun / processJob / processDeadLetter).
  state: RunState
): Promise<void> {
  const enqueuedModels = state.models.filter(m => m.enqueued);
  const caseCount = kind === 'classifier' ? CLASSIFIER_CASES.length : DECIDER_CASES.length;

  // The run finalizes once every lane is accounted for, so one dead lane no
  // longer wedges the run until the stale sweep.
  const { unfinished: deadLanes, deadLaneKeys } = await loadLaneAccounting(
    env.BENCH_DB,
    runId,
    state,
    caseCount
  );
  if (deadLanes.some(lane => !deadLaneKeys.has(laneKey(lane.model, lane.variant, lane.rep)))) {
    return;
  }

  // A classifier run derives one winner from a single comparable set, and its
  // models are not registry-tracked, so a dead lane fails the whole run. Decider
  // runs settle per entry below — one dead model never discards the rest.
  if (deadLanes.length > 0 && kind === 'classifier') {
    const [first, ...rest] = deadLanes;
    await failRunAndDrain(
      env,
      runId,
      `lane dead-lettered: ${first.model} variant ${variantFromStorage(first.variant) ?? 'default'} rep ${first.rep}` +
        (rest.length > 0 ? ` (+${rest.length} more)` : '')
    );
    return;
  }

  // Two consumers may both see completion and both aggregate — harmless:
  // identical deterministic inputs → identical summaries; replaceModelSummaries
  // is a batched delete+insert; markRunCompleted and the per-entry profile
  // transitions guard on status='running'.
  const rows = await getCaseResults(env.BENCH_DB, runId);
  // Fresh results (enqueued models). Carried summaries (skipped models) stay in
  // model_summaries with carried=true and are included via getSummaries below.
  const freshSummaries = summarize(rows, kind);
  await replaceModelSummaries(env.BENCH_DB, runId, freshSummaries);
  await markRunCompleted(env.BENCH_DB, runId);

  // Every decider run feeds the one global registry — the platform routing table
  // and every owner's custom table are assembled from it, so no decider run
  // publishes an artifact of its own.
  if (kind === 'decider') {
    // Entries whose lanes all completed become ready; entries with a dead lane
    // fail (a requeue re-admits them) without taking down the rest of the batch.
    // Fail first so the ready sweep only catches survivors; both statements keep
    // the run_id + status='running' no-clobber guard.
    const failedEntryKeys = new Set(deadLanes.map(l => JSON.stringify([l.model, l.variant])));
    const failedEntries = enqueuedModels
      .filter(m => failedEntryKeys.has(JSON.stringify([m.model, m.variant])))
      .map(m => ({ model: m.model, variant: m.variant }));
    // One try block, fail-first. `markProfilesReadyForRun` has no entry filter —
    // it readies every row still `running` under this run — so it must not run
    // when the per-entry failure did not complete, or a dead lane's partial
    // measurements would be published as a real result. If this throws, the
    // rows stay `running` and the orphan sweep settles them.
    try {
      if (failedEntries.length > 0) {
        await markProfilesFailedForEntries(
          env.BENCH_DB,
          runId,
          failedEntries,
          PROFILE_LANE_DEAD_FAILURE_REASON
        );
      }
      await markProfilesReadyForRun(env.BENCH_DB, runId);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'benchmark_profile_transition_error',
          runId,
          ...formatError(error),
        })
      );
    }
    console.log(
      JSON.stringify({
        event: 'benchmark_decider_run_completed',
        runId,
        purpose: state.purpose,
        readyEntries: enqueuedModels.length - failedEntries.length,
        failedEntries: failedEntries.length,
      })
    );
    // Fresh registry rows may complete the platform model list, so republish.
    await publishPlatformRoutingTable(env).catch(error => {
      console.warn(
        JSON.stringify({
          event: 'routing_table_publish_skipped',
          runId,
          ...formatError(error),
        })
      );
    });
    // Both queues: this run's slot just freed, and a pair it just measured may
    // have been the only pending work the other queue was waiting on.
    await drainQueues(env, 'both');
    return;
  }

  // Read back all summaries (fresh + carried) for publishing.
  const allSummaries = await getSummaries(env.BENCH_DB, runId);

  // Don't let a slow older run overwrite a newer run's already-published table
  // or classifier winner. Publication is selected by publish time, so an older
  // run finishing last would otherwise win. The run is still marked completed
  // above (it did finish); only its publication is suppressed.
  const supersededByNewer = await existsNewerCompletedRun(
    env.BENCH_DB,
    kind,
    state.startedAt,
    runId
  );
  if (supersededByNewer) {
    console.warn(JSON.stringify({ event: 'benchmark_publish_skipped_superseded', runId, kind }));
  }

  if (kind === 'classifier' && !supersededByNewer) {
    const winner = pickClassifierWinner(
      allSummaries,
      state.minAccuracy,
      state.classifierMaxP95LatencyMs
    );
    if (winner) {
      console.log(
        JSON.stringify({ event: 'classifier_winner_published', runId, model: winner.model })
      );
    } else {
      console.warn(JSON.stringify({ event: 'classifier_winner_skipped', runId }));
    }
    // Clear KV so the auto-routing worker repopulates from D1 on next request.
    await env.AUTO_ROUTING_CONFIG.delete(CLASSIFIER_WINNER_KV_KEY);
  }

  console.log(
    JSON.stringify({
      event: 'benchmark_run_completed',
      runId,
      kind,
      purpose: state.purpose,
      summaries: allSummaries,
    })
  );
}

export function summarize(rows: CaseResultRow[], kind: BenchmarkKind): BenchmarkModelSummary[] {
  // Group by (model, variant, routeKey). Classifier rows use '*' because
  // classification has no decider taxonomy route. variant '' → null on emit.
  const groups = new Map<string, CaseResultRow[]>();
  for (const row of rows) {
    const routeKey = kind === 'classifier' ? '*' : (row.route_key ?? '*');
    const storedVariant = row.variant ?? '';
    const key = `${row.model}\0${storedVariant}\0${routeKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  return [...groups.entries()].map(([key, group]) => {
    const [model, storedVariant, routeKey] = key.split('\0');
    const latencies = group.map(r => r.latency_ms).toSorted((a, b) => a - b);
    const costs = group.filter(r => r.cost_usd !== null);
    const p95LatencyMs =
      latencies.length > 0
        ? (latencies[Math.min(latencies.length - 1, Math.ceil(0.95 * latencies.length) - 1)] ??
          null)
        : null;
    return {
      model,
      variant: variantFromStorage(storedVariant),
      routeKey: routeKey as BenchmarkModelSummary['routeKey'],
      accuracy: Number((group.reduce((a, r) => a + r.score, 0) / group.length).toFixed(4)),
      avgCostUsd: costs.length
        ? Number((costs.reduce((a, r) => a + (r.cost_usd ?? 0), 0) / costs.length).toFixed(8))
        : null,
      avgLatencyMs: Math.round(group.reduce((a, r) => a + r.latency_ms, 0) / group.length),
      p50LatencyMs: latencies[Math.floor(latencies.length / 2)] ?? null,
      p95LatencyMs,
      cases: group.length,
      errors: group.filter(r => r.error !== null).length,
      timeouts: group.filter(r => r.timed_out).length,
    };
  });
}
