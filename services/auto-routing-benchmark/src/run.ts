import {
  ClassifierRunError,
  classifyWithSystemOne,
} from '@kilocode/auto-routing-contracts/classifier';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import {
  CLASSIFIER_WINNER_KV_KEY,
  routingTableKvKey,
  AUTO_ROUTERS,
  BenchmarkRunPurposeSchema,
  type AutoRouter,
  type BenchmarkIdentity,
  BenchmarkIdentityError,
  type BenchmarkIdentityOverrides,
  resolveBenchmarkIdentity,
  resolveEffectivePolicy,
  ComplexityLabelsSchema,
  type BenchmarkDeciderModel,
  type BenchmarkKind,
  type BenchmarkModelSummary,
  type BenchmarkProfileFailureClass,
  taxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import { chunkArray } from '@kilocode/worker-utils/chunk-array';
import {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import * as z from 'zod';
import { getBenchmarkConfig } from './config';
import { CLASSIFIER_CASES } from './datasets/classifier-cases';
import caseComplexity from './datasets/case-complexity.json';
import type { RunModelRow, RunRow } from './db';
import {
  adoptReusableCaseResult,
  completePaidCaseStatements,
  countCaseResultsByLane,
  exactPairKey,
  ensureBenchmarkCutover,
  existsNewerCompletedRun,
  getCaseResults,
  getExistingCaseResultIds,
  laneCancelledCaseCounts,
  laneCaseExpectations,
  listPaidRequestCasePlan,
  recordPublishedDesiredPairs,
  listPendingPaidCancellations,
  markPaidCancellationDelivered,
  quarantineProfileClaimsForRuns,
  queuePaidCancellationIntentStatements,
  readBenchmarkCutover,
  readOwnedCaseGeneration,
  deferPaidCancellation,
  restartPaidCaseRunStatement,
  reuseDeciderCaseResults,
  getPendingDeciderOutput,
  savePendingDeciderOutput,
  deletePendingDeciderOutput,
  needsPendingOutputRecovery,
  listPendingOutputRecoveries,
  listCurrentPlatformProfileStatuses,
  claimDeciderGrading,
  releaseDeciderGrading,
  getLatestSummariesByModel,
  getLiveContainerLanes,
  getQueueRunOccupancy,
  getRunningRun,
  getRunWithModels,
  getLatestRoutingTable,
  getSummaries,
  getSummariesForRuns,
  getRoutingCaseResultsForEntries,
  insertRun,
  MAX_RUNNING_RUNS_PER_QUEUE,
  listLaneFailures,
  listPendingCurrentProfiles,
  listReadyCurrentProfilesForEntries,
  listStaleRunningDeciderRuns,
  failPendingProfiles,
  markProfilesFailedForEntries,
  markProfilesFailedForRun,
  markProfilesReadyForEntries,
  markProfilesReadyForRun,
  markProfilesRunningForRun,
  copyRemeasureBaselines,
  listQueuedRemeasures,
  settleRemeasuresForRun,
  releaseProfileClaims,
  releaseProfileClaimsForEntries,
  markRunCompleted,
  markRunFailed,
  markStaleRunsFailed,
  enrollPaidPairStatements,
  releaseUncommittedRunClaimsStatement,
  releaseUnbilledPaidGenerationBatch,
  failOrphanedRunningProfiles,
  failPaidCasesForUnavailablePairStatements,
  recordLaneFailure,
  replaceModelSummaries,
  saveRoutingTable,
  syncPlatformRegistryRows,
  upsertCaseResult,
  type BenchmarkRunPurpose,
  type CaseResultRow,
  type RunLaneFailureRow,
  type StoredDeciderOutput,
  type PriorModelResult,
  type QueueRunOccupancy,
} from './db';
import {
  cancelPaidCaseStatements,
  claimPaidCaseStatements,
  paidUnfundedStopOutcome,
  platformCoverageStatements,
  pausePaidUnfundedCaseStatements,
  completePaidBenchmarkRequestStatements,
  enqueuePaidPoolPinsStatement,
  markServingPairReusedStatements,
  readLiveRequestPairStatement,
  readReusedRequestPairStatement,
  failUnreconciledServingPairStatements,
  readPaidBenchmarkRequest,
  readPaidCaseRun,
  releasePaidCaseGenerationStatements,
  type PaidCaseGeneration,
  type PaidCaseKey,
  type PaidCaseRunRow,
} from './paid-case-store';
import {
  gradeClassifierOutput,
  gradeDeciderOutput,
  gradeProbeOutput,
  lacksRequiredToolCalls,
  DeciderGraderRetryError,
  type DeciderJudge,
} from './grading';
import { createDeciderJudge } from './decider-judge';
import { createSystemOneClient } from './openrouter';
import {
  buildRoutingTable,
  computeRegistryRoutingTableVersion,
  filterSummariesByProvenance,
} from './routing-table-builder';
import { syncRoutingTableVersionPointer } from './routing-table-response';
import {
  addPriorAttempt,
  type AttemptUsage,
  BenchmarkCaseCancelledError,
  BenchmarkCaseNotStartedError,
  CONTAINER_NOT_REACHED_PREFIX,
  DECIDER_CLI_TIMEOUT_MS,
  cancelDeciderCase,
  destroyDeciderCliContainer,
  hasThrottleDiagnostic,
  isRetryableContainerAvailabilityError,
  isExactModelUnavailableResult,
  isCatalogLoadFailureResult,
  isKilledBeforeEventsResult,
  isUnbilledTransientProviderResult,
  type CaseInferenceProxy,
  isUnsupportedModelResult,
  parseContainerRunResponse,
  runDeciderCaseViaCli,
  warmUpCliContainer,
} from './cli-runner';
import { variantFromStorage, variantToStorage } from './reasoning-effort';
import {
  benchmarkPairUnavailability,
  catalogCandidatePrices,
  fetchBenchmarkModelCatalog,
  type BenchmarkModelCatalogSchema,
  type CatalogModel,
} from './platform-models';
import {
  mostSevereFailureClass,
  parseFailureClass,
  unsupportedRejection,
  type ProfileFailure,
} from './profile-failure';
import { settleProfileRunAttempts } from './profile-failure-history';
import { pickClassifierWinner } from './winner';
import { fetchExecutableBenchmarkModelCatalog } from './executable-models';
import { fetchBenchmarkUserToken, type BenchmarkTokenAudience } from './benchmark-token';
import {
  PLATFORM_SUBSCRIPTION_OWNER,
  servingSubscriptionSnapshot,
  snapshotPairs,
  syncSubscriptionSnapshot,
} from './subscriptions';
import {
  acquireInitializationLease,
  restartPaidCaseStatement,
  claimScheduledChunks,
  clearUnbilledCase,
  getPaidCasePromptRevision,
  cooldownCatalog,
  cooldownModel,
  deferCatalogChunk,
  deferChunk,
  deferThrottledChunk,
  failChunk,
  failScheduledEntryStatements,
  finishChunk,
  getChunk,
  getPaidCaseStartedAt,
  getSchedulerOverrides,
  hasScheduledChunks,
  hasUnsettledChunks,
  listSettledSchedulerRuns,
  markSettledRunInitialized,
  recoverChunks,
  releaseInitializationLease,
  resolveSchedulerConfig,
  scheduleRunChunks,
  schedulerBackoffSeconds,
  startChunk,
  SCHEDULER_MAX_ATTEMPTS,
  SCHEDULER_MAX_CATALOG_DEFERRALS,
  SCHEDULER_MAX_THROTTLE_DEFERRALS,
  type SchedulerClaim,
  type SchedulerConfig,
  type PaidExecutionKey,
} from './scheduler';
import {
  ACTIVE_MEASUREMENT_REVISION,
  deciderCasesForRouter,
  ENGINE_IDENTITY_REVISION,
  minimumCaseRevisions,
  PROBE_REVISION,
  type MeasuredCase,
} from './measurement-revision';
import { isProbeCase } from './datasets/probe-cases';
import { BENCHMARK_CASE_HEADER, issueCaseInferenceCapability } from './case-inference-capability';
import { BENCHMARK_CASE_INFERENCE_PATH } from '@kilocode/auto-routing-contracts';
import { applyProbeActivations } from './probe-activation';
import { BenchmarkProbeFamilyError, runCancellableProbeCase } from './probe/executor';
import { agenticEligibilityView, pairsMissingProbeResults } from './probe/eligibility';
import { pauseUnfundedPaidRequests } from './paid-benchmark';
import { PaidBenchmarkPlanSchema } from './paid-benchmark-plan';
import { readAutoRoutingBenchmarkSecret } from './secrets';

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
  claimId?: string;
  claimToken?: string;
  schedulerWake?: boolean;
  recoverOutput?: boolean;
  caseIds?: string[];
  chunk?: number;
  shard?: number;
  shardCount?: number;
  chunkSize?: number;
  importedChunks?: number[];
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
  chunkSize: z.number().int().min(1).max(5).optional(),
  importedChunks: z.array(z.number().int().min(0)).optional(),
  rep: z.number().int().min(0).optional(),
  claimId: z.string().min(1).optional(),
  claimToken: z.string().min(1).optional(),
  schedulerWake: z.boolean().optional(),
  recoverOutput: z.boolean().optional(),
});

/**
 * Cases one model repetition runs for a run kind: the length of the dataset
 * that kind and the run's measurement revision select. Shared with run progress so a
 * displayed total cannot disagree with the count run completion waits for.
 */
export function expectedCaseCount(
  kind: BenchmarkKind,
  router: AutoRouter,
  measurementRevision: number
): number {
  return kind === 'classifier'
    ? CLASSIFIER_CASES.length
    : deciderCasesForRouter(router, measurementRevision).length;
}

const DECIDER_CHUNK_SIZE = 1;

// Classifier calls are OpenRouter System One HTTP requests. Each queue
// invocation owns exactly one case, so a slow request cannot push a batch past
// Cloudflare Queues' 15-minute wall-clock limit.
const CLASSIFIER_CHUNK_SIZE = 1;

// Parallel OpenRouter calls per classifier job. Classifier work holds no
// containers, so it does not draw on BENCHMARK_CONTAINER_BUDGET.
export const BENCHMARK_CLASSIFIER_PARALLELISM = 80;

// Cloudflare Queues caps a single sendBatch at 100 messages. Classifier fan-out
// can exceed that because each classifier case is its own message, so dispatch
// must be sliced.
const QUEUE_SEND_BATCH_LIMIT = 100;

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
      await failRunAndDrain(env, runId, { failureClass: 'run_init_failed', reason }).catch(
        () => {}
      );
      throw error;
    }
  }
}

/**
 * Mark a running run failed, fail the registry rows it claimed, then try to
 * drain both queues into whatever slot just freed up.
 */
export async function failRunAndDrain(
  env: Env,
  runId: string,
  failure: ProfileFailure
): Promise<void> {
  await markRunFailed(env.BENCH_DB, runId, failure.reason);
  try {
    await markProfilesFailedForRun(env.BENCH_DB, runId, failure);
  } catch (profileError) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_profile_fail_transition_error',
        runId,
        ...formatError(profileError),
      })
    );
  }
  for (const router of AUTO_ROUTERS) await drainQueues(env, 'both', undefined, router);
}

const STALE_RUN_MAX_AGE_MS = 6 * 3600_000;

// Fails any run still 'running' past the stale threshold (queue retries
// exhausted / dead-lettered). Called before starting a run and by the
// per-minute cron, so a wedged run is recovered without depending on a new run
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
    await markProfilesFailedForRun(db, run.id, {
      failureClass: 'run_timed_out',
      reason: 'timed out',
    }).catch(() => {});
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
    expectedCaseCount('decider', state.router, state.measurementRevision)
  );
  for (const lane of unfinished) {
    if (deadLaneKeys.has(laneKey(lane.model, lane.variant, lane.rep))) continue;
    await recordLaneFailure(env.BENCH_DB, {
      runId,
      ...lane,
      chunk: 0,
      shard: 0,
      failureClass: 'run_timed_out',
    });
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
 * Sweep stale runs, reconcile the platform queue, then drain both registry
 * queues. Used by the scheduled handler so a failed final queue message cannot
 * strand pending work. Never throws for drain/slot contention.
 */
export async function sweepStaleRunsAndDrain(
  env: Env,
  router: AutoRouter = 'efficient'
): Promise<{
  staleRunIds: string[];
  drained: StartedQueueRun[];
}> {
  const staleRunIds = await sweepStaleRuns(env);
  const recoveries = await listPendingOutputRecoveries(
    env.BENCH_DB,
    router,
    computeEngineIdentity('decider', router),
    10
  );
  for (const key of recoveries) {
    await env.BENCH_QUEUE.send({
      runId: key.run_id,
      kind: 'decider',
      model: key.model,
      variant: variantFromStorage(key.variant),
      rep: key.rep,
      caseIds: [key.case_id],
      recoverOutput: true,
    } satisfies BenchmarkJobMessage);
  }
  // Each platform drain reconciles the catalog before claiming entries.
  const drained = await drainQueues(env, 'both', undefined, router);
  await dispatchScheduler(env);
  return { staleRunIds, drained };
}

export type StartedQueueRun = {
  router: AutoRouter;
  runId: string;
  purpose: BenchmarkRunPurpose;
  entryCount: number;
};

/**
 * Drain the selected registry queues. Only the platform queue drains automatically;
 * the `user` selector is accepted for callers that have not moved yet and retires
 * without touching any work. A user-pool measurement starts only from an explicit
 * funded paid request (`startPaidRequestRun`). Drain failures are logged per queue,
 * never thrown, so one wedged queue cannot block another.
 */
export async function drainQueues(
  env: Env,
  selector: 'platform' | 'user' | 'both',
  // Filled with whatever each queue threw. The scheduled callers ignore it; an
  // admin who pressed a button needs to be told the queue is wedged instead of
  // being shown "nothing to run".
  errors?: unknown[],
  router: AutoRouter = 'efficient',
  // A caller that reconciled the platform queue itself, in this same request
  // (the config save), skips the drain's own reconcile. It would read the same
  // saved decider list and write the same rows again.
  options: { skipPlatformSync?: boolean; skipped?: DrainSkipReason[] } = {}
): Promise<StartedQueueRun[]> {
  if (selector === 'user') {
    console.log(JSON.stringify({ event: 'benchmark_user_queue_retired', router }));
    options.skipped?.push('nothing_pending');
    return [];
  }
  const queues: BenchmarkRunPurpose[] = ['platform'];
  const started: StartedQueueRun[] = [];
  for (const queue of queues) {
    try {
      const drained = await drainQueue(env, queue, router, options);
      if (drained) started.push({ ...drained, router, purpose: queue });
    } catch (error) {
      errors?.push(error);
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

// Must match the daily entry of `triggers.crons` in wrangler.jsonc.
export const PLATFORM_SYNC_CRON = '0 5 * * *';
export const PLATFORM_SYNC_SCHEDULE = 'daily at 05:00 UTC';

/**
 * Reconcile the platform queue with the saved decider model list. Every
 * configured exact pair ends up with a current-engine registry row; pairs that
 * already have a `ready` row (measured for an owner pool, or by an earlier
 * platform run) keep it and are not re-benchmarked.
 */
export async function syncPlatformRegistry(
  env: Env,
  fetchImpl: typeof fetch = fetch,
  router: AutoRouter = 'efficient'
): Promise<{ desiredEntries: number }> {
  const config = await getBenchmarkConfig(env.BENCH_DB, router);
  if (!config) return { desiredEntries: 0 };
  const snapshot = await syncSubscriptionSnapshot(
    env,
    config,
    PLATFORM_SUBSCRIPTION_OWNER,
    config.deciderModels.map(model => ({ model: model.id })),
    { fetchImpl }
  );
  const desired = snapshotPairs(snapshot);
  await syncPlatformRegistryRows(
    env.BENCH_DB,
    {
      router,
      engineIdentity: computeEngineIdentity('decider', router),
      repetitions: resolveEffectivePolicy(config).deciderRepetitions,
    },
    desired
  );
  return { desiredEntries: desired.length };
}

/**
 * Rebuild and publish the platform routing table from the registry. Candidates
 * come from ready+current registry rows for the configured platform pairs, each
 * bound to its own measuring run's summaries — the same provenance rule owner
 * pools use, so platform and user tables read the one shared measurement set.
 *
 * The table is published once every pair it currently serves has a ready
 * current-engine row. A pair still being measured is not served yet: the
 * subscription promotes `servingPairs` only when the whole replacement set is
 * ready, so it never appears in `desired` first. Waiting for the entire platform
 * queue to settle instead lets one slow measurement — including one claimed by
 * the user queue, which shares the registry row — hold back every other
 * improvement to the live table for as long as it runs.
 *
 * This still refuses to publish a table thinner than the live one. After an
 * engine bump every row is re-requested under the new engine, so `desired` keeps
 * the previous serving pairs, no ready row matches them, and publishing waits.
 *
 * `flushUnchangedTable` drops the gateway's cached table even when the rebuilt
 * version equals the stored one. An admin save sets it, so saving again repairs
 * a cache flush that failed after the table was written. The cron and run-end
 * paths leave it off: flushing on every publish would send the gateway's
 * read-through traffic to D1 each time.
 */
export async function publishPlatformRoutingTable(
  env: Env,
  fetchImpl: typeof fetch = fetch,
  router: AutoRouter = 'efficient',
  options: {
    flushUnchangedTable?: boolean;
    allowConfigOnlyPublish?: boolean;
    /** The admin save observed a real policy change (complete before/after projection). */
    policyChanged?: boolean;
  } = {}
): Promise<{ version: string } | null> {
  const config = await getBenchmarkConfig(env.BENCH_DB, router);
  if (!config) {
    console.warn(JSON.stringify({ event: 'routing_table_publish_skipped_unconfigured', router }));
    return null;
  }

  const current = {
    router,
    engineIdentity: computeEngineIdentity('decider', router),
    repetitions: resolveEffectivePolicy(config).deciderRepetitions,
  };
  const catalog = await fetchBenchmarkModelCatalog(env, fetchImpl);
  const snapshot = await servingSubscriptionSnapshot(
    env.BENCH_DB,
    config,
    PLATFORM_SUBSCRIPTION_OWNER
  );
  // A serving pair the current target set no longer contains means the alias moved and
  // its replacement is not ready yet (or resolution failed). The table keeps the pair
  // that is still serving, so the rebuild would drop a live model: hold, and say why.
  type StaleServing = {
    model: string;
    reason: 'resolution_error' | 'replacement_pending';
    error?: string;
    held?: { model: string; variant: string | null }[];
  };
  const staleServing: StaleServing[] = [];
  for (const entry of snapshot) {
    if (!entry.model.startsWith('~') || entry.servingPairs.length === 0) continue;
    if (entry.resolutionError) {
      staleServing.push({
        model: entry.model,
        reason: 'resolution_error',
        error: entry.resolutionError,
      });
      continue;
    }
    const movedAway = entry.servingPairs.filter(
      serving =>
        !entry.pairs.some(
          target => target.model === serving.model && target.variant === serving.variant
        )
    );
    if (movedAway.length > 0)
      staleServing.push({ model: entry.model, reason: 'replacement_pending', held: movedAway });
  }
  if (staleServing.length > 0) {
    console.log(
      JSON.stringify({
        event: 'routing_table_publish_skipped_serving_target_pending',
        router,
        held: staleServing,
      })
    );
    return null;
  }
  const desired = snapshotPairs(snapshot, true);
  const targets = new Set(
    snapshotPairs(snapshot, false).map(pair => exactPairKey(pair.model, pair.variant))
  );
  const prices = catalogCandidatePrices(catalog);

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
  // A deploy must reproduce the live artifact, not rebuild it. Rebuilding an unchanged
  // pool under a newer measurement revision can narrow routes (probe eligibility drops
  // agentic candidates), and a profile copied entirely from historical rows is not a new
  // measurement. So a platform publish happens only when the desired serving set itself
  // changed — a model added or removed, or an alias pin advanced — and never requires
  // fresh inference: reusable results are enough. An admin save that changes policy asks
  // for `allowConfigOnlyPublish` explicitly.
  //
  // `desired` is the serving set, which `servingSubscriptionSnapshot` already restricts
  // to ready rows, so it cannot show that a live pair is about to disappear. The live
  // table can: a pair it serves, that is still a target, and that has no ready row under
  // this engine would drop out of the new build. A measurement in flight holds the whole
  // table until it settles. A settled failure has nothing coming: holding on it froze
  // every other table change for the router until an operator re-admitted that pair by
  // hand, so the pair leaves the table (the rest still publishes) and is named instead.
  // A D1 read fault must not look like "no previous table": that would license a rebuild
  // of the live artifact. Only a genuinely absent row publishes unconditionally.
  const previous = await getLatestRoutingTable(env.BENCH_DB, router);
  const publishedPairs = new Map<string, { model: string; variant: string | null }>();
  for (const candidates of Object.values(previous?.table.routes ?? {})) {
    for (const candidate of candidates) {
      const variant = candidate.variant ?? null;
      publishedPairs.set(exactPairKey(candidate.model, variant), {
        model: candidate.model,
        variant,
      });
    }
  }
  const desiredKeys = new Set(desired.map(pair => exactPairKey(pair.model, pair.variant)));
  // Fail closed when the cutover marker is unreadable: a worker that cannot tell whether
  // this pool predates the paid cutover must not rebuild the live artifact.
  const cutoverAt = await readBenchmarkCutover(env.BENCH_DB).catch(() => null);
  if (cutoverAt === null) {
    console.log(JSON.stringify({ event: 'routing_table_publish_skipped_no_cutover', router }));
    return null;
  }
  // Exact membership is the durable baseline. Ranked routes cannot stand in for it: a
  // configured pair whose probe results are incomplete is absent from `routes` while still
  // desired, so comparing against candidates reports a change that never happened.
  //
  // A publication written before this column existed has no baseline. Rather than infer one
  // (and risk a false positive that rebuilds a narrowed table), the current configured and
  // resolved membership is recorded on it once, without touching the artifact. That makes
  // an unchanged pool a no-op from now on, while a genuine addition, removal or alias pin
  // still publishes — no provider work and no fresh inference required.
  const currentMembership = [...desiredKeys].sort();
  const previousMembership = previous?.desiredPairs
    ? new Set(previous.desiredPairs)
    : previous
      ? await (async () => {
          await recordPublishedDesiredPairs(
            env.BENCH_DB,
            previous.table.version,
            currentMembership
          );
          return new Set(currentMembership);
        })()
      : null;
  const desiredChanged =
    previous === null ||
    (previousMembership !== null &&
      (desiredKeys.size !== previousMembership.size ||
        [...desiredKeys].some(key => !previousMembership.has(key))));
  // Two deliberate changes must still publish even though membership is unchanged, and
  // neither is a deploy-time rebuild:
  //  - a genuine NEW measurement: the registry row contributing to this table was measured by
  //    a run that started after the live table was published, so the artifact predates it;
  //  - a deliberate policy change: an admin save changed a knob the table is built from.
  // A deployment replay, a replayed sync or an unchanged save satisfies neither, so the
  // artifact still cannot be rebuilt by accident under a newer eligibility revision.
  // A policy change is only recognized from an explicit opt-in (`policyChanged`, supplied by
  // the admin save that observed its own before/after), never inferred by comparing a partial
  // projection: the table's version covers knobs this function does not read, so a guess could
  // either miss a real edit or invent one from unrecorded legacy data — and the latter would
  // break the no-op deploy rehearsal. An unchanged save is cache-only.
  const policyChanged = options.policyChanged === true;
  const publishedAt = previous?.publishedAt ?? null;
  const freshlyMeasured =
    publishedAt !== null &&
    readyEntries.length > 0 &&
    (await (async () => {
      const rows = await env.BENCH_DB.prepare(
        `SELECT 1 FROM benchmark_runs
        WHERE id IN (${readyEntries.map(() => '?').join(', ')}) AND started_at > ? LIMIT 1`
      )
        .bind(...readyEntries.map(entry => entry.runId), publishedAt)
        .first();
      return rows !== null;
    })());
  // A pair the live table actually serves, that is still a target, and that has no ready row
  // under this engine would drop out of a rebuild. A measurement in flight is still coming;
  // a settled failure is not, and holding on it would freeze every other table change for the
  // router until an operator re-admitted that pair by hand.
  //
  // This is read from what the live table serves (`publishedPairs`), never from the desired set,
  // so a pair the artifact never contained — a legacy permanent failure, or one already omitted
  // by an earlier post-cutover publish — cannot license a rewrite of an unchanged artifact.
  // One read carries both the status and the failure instant, so the two facts can never disagree
  // (a separate query could observe a row mid-transition).
  const statusesByPair = new Map(
    (await listCurrentPlatformProfileStatuses(env.BENCH_DB, current)).map(row => [
      exactPairKey(row.model, row.variant),
      row,
    ])
  );
  const readyPairKeys = new Set(
    readyEntries.map(({ entry }) => exactPairKey(entry.model, entry.variant))
  );
  const servedButUnready = [...publishedPairs.values()].filter(pair => {
    const key = exactPairKey(pair.model, pair.variant);
    return !readyPairKeys.has(key) && targets.has(key);
  });
  // Only a failure that settled *after* the durable cutover marker may trigger a rewrite. A pair
  // that was already failed when the artifact was carried over keeps its old failure instant
  // forever, so neither the first tick nor the second (after `desiredPairs` bootstraps) can
  // reclassify it. `completed_at` is the failure transition's own timestamp, so a retry timer
  // elapsing moves `retry_after` and never this. A row with no failure instant fails closed.
  const settledDrops = servedButUnready.filter(pair => {
    const row = statusesByPair.get(exactPairKey(pair.model, pair.variant));
    return (
      row !== undefined &&
      row.status === 'failed' &&
      row.completed_at !== null &&
      row.completed_at > cutoverAt
    );
  });
  // A served pair settling into a failure is a genuine post-cutover change, so it publishes even
  // though the desired membership did not move. Everything else about an unchanged pool stays a
  // no-op: a deploy replay or an untouched legacy configuration never rewrites the artifact.
  if (
    !desiredChanged &&
    !freshlyMeasured &&
    !policyChanged &&
    settledDrops.length === 0 &&
    !options.allowConfigOnlyPublish
  ) {
    // An unchanged pool is never rebuilt (rebuilding could narrow rev3 eligibility), but an
    // admin save still asked for the gateway cache to be repaired: reuse the live artifact,
    // re-point readers at its version and drop exactly the routing-table KV key. No table is
    // constructed, no D1 row is written.
    if (previous !== null && options.flushUnchangedTable) {
      await syncRoutingTableVersionPointer(env, router);
      await env.AUTO_ROUTING_CONFIG.delete(routingTableKvKey(router));
      console.log(
        JSON.stringify({
          event: 'routing_table_unchanged_flushed',
          router,
          version: previous.table.version,
        })
      );
      return { version: previous.table.version };
    }
    console.log(
      JSON.stringify({
        event: 'routing_table_publish_skipped_unchanged_desired_set',
        router,
        desiredEntries: desiredKeys.size,
        publishedEntries: publishedPairs.size,
      })
    );
    return null;
  }
  // A settled failure is a row that will not be measured again on its own: `failed` after
  // its retry window, or a permanent `unavailable` — which `listCurrentPlatformProfileStatuses`
  // reports as `failed` (db.ts), so both arrive here in one class. A `pending`/`running` row
  // is a measurement in flight, and a missing row is an engine the registry has not touched
  // yet; those keep holding the table.
  const settledFailure = (pair: { model: string; variant: string | null }) =>
    statusesByPair.get(exactPairKey(pair.model, pair.variant))?.status === 'failed';
  const unreadyLivePairs = servedButUnready;
  const dropped = unreadyLivePairs.find(pair => !settledFailure(pair));
  if (dropped) {
    console.log(
      JSON.stringify({
        event: 'routing_table_publish_skipped_serving_pair_unready',
        model: dropped.model,
        variant: dropped.variant,
        status:
          statusesByPair.get(exactPairKey(dropped.model, dropped.variant))?.status ?? 'missing',
      })
    );
    return null;
  }
  const leftOut = settledDrops;
  if (leftOut.length > 0)
    console.log(
      JSON.stringify({
        event: 'routing_table_publish_dropped_failed_pairs',
        router,
        dropped: leftOut.map(pair => ({
          model: pair.model,
          variant: pair.variant,
          status: statusesByPair.get(exactPairKey(pair.model, pair.variant))?.status,
        })),
      })
    );

  // Probe eligibility is route-scoped: a pair whose provenance run lacks complete probe
  // results is ineligible on the agentic routes only and keeps serving every other route
  // with the measurement it has. Before the probe revision is active nothing is filtered.
  const probesActive = router === 'efficient' && ACTIVE_MEASUREMENT_REVISION >= PROBE_REVISION;
  const ineligible = probesActive
    ? await pairsMissingProbeResults(env.BENCH_DB, {
        entries: readyEntries,
        revision: PROBE_REVISION,
      })
    : new Set<string>();
  if (ineligible.size > 0) {
    console.log(
      JSON.stringify({
        event: 'routing_table_agentic_ineligible_pairs',
        probeRevision: PROBE_REVISION,
        pairs: [...ineligible],
      })
    );
  }
  const [summaries, perCaseResults] = await Promise.all([
    getSummariesForRuns(env.BENCH_DB, [...new Set(readyEntries.map(r => r.runId))]),
    getRoutingCaseResultsForEntries(env.BENCH_DB, readyEntries),
  ]);
  const view = agenticEligibilityView({
    active: probesActive,
    ineligible,
    summaries: filterSummariesByProvenance(readyEntries, summaries),
    perCaseResults,
    ...(previous?.table.routes ? { previousRoutes: previous.table.routes } : {}),
  });
  const tableSummaries = view.summaries;
  const tableCaseResults = view.perCaseResults;
  const fallbackRoutes = view.fallbackRoutes;
  if (view.heldRouteKeys.length > 0) {
    console.log(
      JSON.stringify({
        event: 'routing_table_agentic_route_held',
        routes: view.heldRouteKeys,
        heldFromPrevious: Object.keys(fallbackRoutes),
      })
    );
  }
  const generatedAt = new Date().toISOString();
  const deciderModels: BenchmarkDeciderModel[] = readyEntries.map(({ entry }) => ({
    id: entry.model,
    variant: entry.variant,
    reasoningEffort: null,
  }));
  const policy = resolveEffectivePolicy(config);
  const minAccuracy = Math.min(
    1,
    policy.minAccuracy + (router === 'frontier' ? policy.frontierMinAccuracyDelta : 0)
  );
  const table = buildRoutingTable({
    version: generatedAt,
    generatedAt,
    minAccuracy,
    accuracyNoiseBand: policy.accuracyNoiseBand,
    switchCostFactor: policy.switchCostFactor,
    bestAccuracySwitchThreshold: policy.bestAccuracySwitchThreshold,
    productionTokenProfile: policy.productionTokenProfile,
    switchHorizonTurns: policy.switchHorizonTurns,
    lowConfidenceThreshold: policy.lowConfidenceThreshold,
    prices,
    deciderModels,
    summaries: tableSummaries,
    perCaseResults: tableCaseResults,
    complexityLabels: ComplexityLabelsSchema.parse(caseComplexity),
    fallbackRoutes,
  });
  table.version = `${computeRegistryRoutingTableVersion(
    readyEntries.map(r => ({ runId: r.runId, model: r.entry.model, variant: r.entry.variant })),
    {
      router,
      engineIdentity: current.engineIdentity,
      accuracyNoiseBand: policy.accuracyNoiseBand,
      frontierMinAccuracyDelta: policy.frontierMinAccuracyDelta,
      minAccuracy,
      switchCostFactor: policy.switchCostFactor,
      bestAccuracySwitchThreshold: policy.bestAccuracySwitchThreshold,
      productionTokenProfile: policy.productionTokenProfile,
      switchHorizonTurns: policy.switchHorizonTurns,
      lowConfidenceThreshold: policy.lowConfidenceThreshold,
      prices,
      summaries: tableSummaries,
      effortByComplexity: table.effortByComplexity,
    }
  )}-variants`;

  // The version hashes the contributing registry rows and the config knobs, so
  // an identical version means an identical table. Skip the write, and the
  // flush unless the caller asked for it.
  if (previous?.table.version === table.version) {
    await syncRoutingTableVersionPointer(env, router);
    if (options.flushUnchangedTable) {
      await env.AUTO_ROUTING_CONFIG.delete(routingTableKvKey(router));
    }
    return { version: table.version };
  }

  await saveRoutingTable(env.BENCH_DB, table, generatedAt, router, [...desiredKeys].sort());
  await syncRoutingTableVersionPointer(env, router);
  await env.AUTO_ROUTING_CONFIG.delete(routingTableKvKey(router));
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
// carried summary to be re-benchmarked on the next run. A change confined to some
// cases adds a measurement revision instead (src/measurement-revision.ts), which
// re-measures only those cases once ACTIVE_MEASUREMENT_REVISION reaches it.
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
// model's prior summaries can be carried instead of re-run. The hash covers the
// cases of ENGINE_IDENTITY_REVISION; later measurement revisions keep it.
export function computeEngineIdentity(
  kind: BenchmarkKind,
  router: AutoRouter = 'efficient'
): string {
  const selectedRouter = kind === 'classifier' ? 'efficient' : router;
  const datasetSignature =
    kind === 'classifier'
      ? { engine: 'system-one', cases: CLASSIFIER_CASES }
      : deciderCasesForRouter(selectedRouter, ENGINE_IDENTITY_REVISION);
  return `${selectedRouter}:v${BENCHMARK_ENGINE_VERSION}:${fnv1aHex(JSON.stringify(datasetSignature))}`;
}

function normalizeRunModelEntries(models: readonly (string | RunModelEntry)[]): RunModelEntry[] {
  return models.map(entry => (typeof entry === 'string' ? { model: entry, variant: null } : entry));
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

// Thrown when a classifier run is already active. The admin route maps it to
// HTTP 409 so automated callers can distinguish it from a 5xx fault.
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
 * Thrown when every entry of a batch was already claimed by another run. Not a
 * fault: the pairs are being measured, just not by this run.
 */
export class NoEntriesClaimedError extends Error {
  constructor(readonly runId: string) {
    super(`no registry entries left to claim for ${runId}`);
    this.name = 'NoEntriesClaimedError';
  }
}

/**
 * Thrown when a decider queue refuses a new run because one of its runs is still
 * starting or it already holds MAX_RUNNING_RUNS_PER_QUEUE runs. The claims are
 * released; the next drain retries.
 */
export class QueueRunNotAdmittedError extends Error {
  constructor(readonly occupancy: QueueRunOccupancy) {
    super(
      occupancy.startingRunId !== null
        ? `run ${occupancy.startingRunId} of this queue is still starting`
        : `this queue already has ${occupancy.activeRuns} active runs`
    );
    this.name = 'QueueRunNotAdmittedError';
  }
}

/**
 * Thrown when a live operator pause on the dispatch lock refuses a run start. Nothing was
 * claimed and nothing was enqueued; the admin route answers like a held drain.
 */
export class RunOperatorHoldError extends Error {
  constructor() {
    super('an operator pause holds the benchmark dispatch lock');
    this.name = 'RunOperatorHoldError';
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

/**
 * This request's frozen plan can never be launched: its repetitions, engine identity,
 * measurement revision or plan payload no longer match the engine. Distinct from
 * {@link BenchmarkRunConfigError}, which also covers deployment-wide misconfiguration
 * (missing config, a non-bot executor override) that an operator can fix and that must
 * stay retryable for the request.
 */
export class BenchmarkPaidPlanError extends BenchmarkRunConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkPaidPlanError';
  }
}

// A saved non-bot identity override is an admin configuration error (400),
// resolved before any claim or run row so nothing has to be rolled back.
export function resolveRunIdentity(config: BenchmarkIdentityOverrides): BenchmarkIdentity {
  try {
    return resolveBenchmarkIdentity(config);
  } catch (error) {
    if (error instanceof BenchmarkIdentityError) throw new BenchmarkRunConfigError(error.message);
    throw error;
  }
}

export type StartRunOptions = {
  router?: AutoRouter;
  /** Classifier only: re-measure models that already have current results. */
  force?: boolean;
  /** Which registry queue this run drains. Classifier runs are always 'platform'. */
  purpose?: BenchmarkRunPurpose;
  /**
   * The explicit funded request that owns a `user` run. Required for that purpose: the
   * automatic owner queue is retired, so only a paid admission may start one.
   */
  paidRequestId?: string;
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
  const router = kind === 'classifier' ? 'efficient' : (options.router ?? 'efficient');
  const purpose: BenchmarkRunPurpose = options.purpose ?? 'platform';
  if (purpose === 'user' && !options.paidRequestId) {
    // The automatic owner queue is retired. A user-pool measurement is admitted only by
    // an explicit funded paid request (`startPaidRequestRun`), never by a subscription,
    // a pool edit, an alias move, a schedule or a retry handler.
    throw new BenchmarkRunConfigError(
      'The user benchmark queue is retired; start an explicit paid benchmark request instead.'
    );
  }
  if (kind === 'decider' && (!options.entries || options.entries.length === 0)) {
    throw new BenchmarkRunConfigError('decider runs require a non-empty registry entry snapshot');
  }

  // Stale-run sweeper: fail dead 'running' runs first so a wedged run can't
  // block new ones and the admin panel shows the truth.
  await sweepStaleRuns(env);

  const config = await getBenchmarkConfig(env.BENCH_DB, router);
  if (!config) {
    throw new Error('benchmark config not set: save it in the admin panel before starting a run');
  }
  const benchmarkIdentity = resolveRunIdentity(config);
  const policy = resolveEffectivePolicy(config);

  // One active classifier run: it derives a single winner. The unique partial
  // index is the atomic backstop; this pre-check turns the common case into a
  // clean RunAlreadyActiveError instead of an insert-constraint failure.
  // Decider queues admit several runs; drainQueue bounds them.
  if (kind === 'classifier') {
    const activeRun = await getRunningRun(env.BENCH_DB, kind, purpose, router);
    if (activeRun) {
      throw new RunAlreadyActiveError(kind, activeRun.id);
    }
  }
  const repetitions =
    kind === 'classifier' ? policy.classifierRepetitions : policy.deciderRepetitions;

  // Decider entries always come from the registry queue snapshot (which may
  // include two variants of one model). Classifier still measures its own list.
  const modelEntries: RunModelEntry[] =
    kind === 'decider'
      ? normalizeRunModelEntries(options.entries ?? [])
      : config.classifierModels.map(model => ({ model, variant: null }));

  const engineIdentity = computeEngineIdentity(kind, router);

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
      : await getLatestSummariesByModel(env.BENCH_DB, kind, router);
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

  const laneBudget = kind === 'classifier' ? BENCHMARK_CLASSIFIER_PARALLELISM : 0;

  const startedAt = new Date().toISOString();
  // Distinguish user-queue run ids so ops logs and D1 rows are easy to filter.
  // The nonce matters: two drains of one queue can reach here in the same
  // millisecond, and a shared id makes each one's claim match the other's rows —
  // the loser's release would then hand back rows the winner is measuring.
  const runId =
    (router === 'frontier' ? 'frontier-' : '') +
    (purpose === 'user' ? 'user' : kind) +
    `-${startedAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;

  // Claim the registry rows BEFORE writing the run. Both queues drain from the
  // same registry and their drains can overlap (cron, admin, run completion), so
  // whichever claim lands first owns the pair; the loser drops it instead of
  // paying to benchmark it a second time and then discarding the result.
  let claimedEntries: RunModelEntry[] = modelEntries;
  if (kind === 'decider') {
    try {
      claimedEntries = await markProfilesRunningForRun(env.BENCH_DB, runId, modelEntries, {
        router,
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
    const admission = await insertRun(
      env.BENCH_DB,
      {
        id: runId,
        router,
        accuracy_noise_band: policy.accuracyNoiseBand,
        frontier_min_accuracy_delta: policy.frontierMinAccuracyDelta,
        kind,
        startedAt,
        min_accuracy: policy.minAccuracy,
        switch_cost_factor: policy.switchCostFactor,
        best_accuracy_switch_threshold: policy.bestAccuracySwitchThreshold,
        max_concurrency: laneBudget,
        benchmark_user_id: benchmarkIdentity.benchmarkUserId,
        benchmark_org_id: benchmarkIdentity.benchmarkOrgId,
        repetitions,
        classifier_max_p95_latency_ms:
          kind === 'classifier' ? policy.classifierMaxP95LatencyMs : null,
        engine_identity: engineIdentity,
        measurement_revision: ACTIVE_MEASUREMENT_REVISION,
        purpose,
      },
      runModelRows,
      carriedSummaries
    );
    if (!admission.admitted) {
      if ('operatorHold' in admission) throw new RunOperatorHoldError();
      throw new QueueRunNotAdmittedError(admission.occupancy);
    }
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
    if (kind === 'classifier') {
      const winner = await getRunningRun(env.BENCH_DB, kind, purpose, router).catch(
        () => undefined
      );
      if (winner && winner.id !== runId) {
        throw new RunAlreadyActiveError(kind, winner.id);
      }
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
      router,
      status: 'running',
      minAccuracy: policy.minAccuracy,
      switchCostFactor: policy.switchCostFactor,
      bestAccuracySwitchThreshold: policy.bestAccuracySwitchThreshold,
      benchmarkUserId: benchmarkIdentity.benchmarkUserId,
      benchmarkOrgId: benchmarkIdentity.benchmarkOrgId,
      models: runModelRows,
      repetitions,
      classifierMaxP95LatencyMs: kind === 'classifier' ? policy.classifierMaxP95LatencyMs : null,
      startedAt,
      purpose,
      engineIdentity,
      measurementRevision: ACTIVE_MEASUREMENT_REVISION,
    });
    return { runId, enqueuedModels: 0, skippedModels };
  }

  if (kind === 'classifier') {
    const chunks = chunkArray(CLASSIFIER_CASES, CLASSIFIER_CHUNK_SIZE);
    const messages = buildClassifierMessages(runId, enqueuedRunEntries, repetitions, chunks);
    await enqueueRunMessages(env, runId, messages);
    return { runId, enqueuedModels: enqueuedRunEntries.length, skippedModels };
  }

  // Reuse and chunk materialization run in the dispatcher's initialization pass, which
  // the per-minute cron retries, so nothing after the run row can fail this start.
  await env.BENCH_QUEUE.send({
    runId,
    kind: 'decider',
    model: enqueuedRunEntries[0].model,
    schedulerWake: true,
  } satisfies BenchmarkJobMessage).catch((error: unknown) => {
    console.warn(
      JSON.stringify({ event: 'benchmark_scheduler_wake_failed', runId, ...formatError(error) })
    );
  });
  return { runId, enqueuedModels: enqueuedRunEntries.length, skippedModels };
}

/**
 * Registry queues: one per router and run purpose. Each starts one run at a time.
 */
const REGISTRY_QUEUES = AUTO_ROUTERS.length * BenchmarkRunPurposeSchema.options.length;

function logQueueDrainSkipped(
  router: AutoRouter,
  queue: BenchmarkRunPurpose,
  occupancy: QueueRunOccupancy
): void {
  console.log(
    JSON.stringify(
      occupancy.startingRunId !== null
        ? {
            event: 'benchmark_queue_drain_skipped_run_starting',
            router,
            queue,
            startingRunId: occupancy.startingRunId,
          }
        : {
            event: 'benchmark_queue_drain_skipped_queue_full',
            router,
            queue,
            activeRuns: occupancy.activeRuns,
          }
    )
  );
}

/**
 * Why a queue drain started no run. `active_run` means the queue's slot is
 * taken and the new work waits for it; `nothing_pending` means the queue holds
 * nothing to claim, so it waits for a registration, not for a run to end.
 */
export type DrainSkipReason = 'active_run' | 'nothing_pending';

export async function drainQueue(
  env: Env,
  queue: BenchmarkRunPurpose,
  router: AutoRouter = 'efficient',
  options: { skipPlatformSync?: boolean; skipped?: DrainSkipReason[] } = {}
): Promise<{ runId: string; entryCount: number } | null> {
  // The user queue is retired: only an explicit funded paid request admits user work
  // (`startPaidRequestRun`). Nothing here may enroll a subscription, schedule or retry.
  if (queue !== 'platform') {
    options.skipped?.push('nothing_pending');
    return null;
  }
  // Every drain needs the durable cutover instant: it decides which requested work the
  // deploy may measure. Without it, do nothing rather than schedule legacy work.
  let cutoverAt: string;
  try {
    cutoverAt = await ensureBenchmarkCutover(env.BENCH_DB);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_cutover_unavailable',
        router,
        ...formatError(error),
      })
    );
    options.skipped?.push('nothing_pending');
    return null;
  }
  // A measurement-revision activation lands as data before this image is live; only a
  // worker that knows `probe_activations` consumes it, so it is applied here and never by
  // the previous one (which would have measured the rows at the revision it knows).
  // Rows staged before the cutover are not consumed at all: they request work the deploy
  // must not schedule again.
  const activation = await applyProbeActivations(
    env.BENCH_DB,
    router,
    Date.now(),
    ACTIVE_MEASUREMENT_REVISION,
    cutoverAt
  );
  if (activation.queued > 0 || activation.readmitted > 0) {
    console.log(
      JSON.stringify({
        event: 'benchmark_probe_activation_applied',
        router,
        queued: activation.queued,
        readmitted: activation.readmitted,
      })
    );
  }
  const config = await getBenchmarkConfig(env.BENCH_DB, router);
  if (!config) {
    // No saved config means no registry rows to claim: nothing is pending.
    options.skipped?.push('nothing_pending');
    return null;
  }

  // One run per queue materializes at a time, so the costly start step (reuse
  // copies and chunk creation) stays serial. insertRun enforces this atomically;
  // this read skips the claim and catalog work while the queue cannot admit a run.
  const occupancy = await getQueueRunOccupancy(env.BENCH_DB, router, queue);
  if (occupancy.startingRunId !== null || occupancy.activeRuns >= MAX_RUNNING_RUNS_PER_QUEUE) {
    options.skipped?.push('active_run');
    logQueueDrainSkipped(router, queue, occupancy);
    return null;
  }

  // Reconcile saved snapshots, not the live alias targets.
  if (queue === 'platform' && !options.skipPlatformSync)
    await syncPlatformRegistry(env, fetch, router);

  const engineIdentity = computeEngineIdentity('decider', router);
  const repetitions = resolveEffectivePolicy(config).deciderRepetitions;
  const maxEntries = 100;

  const current = { router, engineIdentity, repetitions, requestedAfter: cutoverAt };
  const pending = await listPendingCurrentProfiles(env.BENCH_DB, current, queue);
  const remeasures = await listQueuedRemeasures(env.BENCH_DB, current, queue);
  if (pending.length === 0 && remeasures.length === 0) {
    options.skipped?.push('nothing_pending');
    return null;
  }
  const catalog = await fetchExecutableBenchmarkModelCatalog(env, resolveRunIdentity(config));
  const checked = pending.map(row => ({
    row,
    failure: benchmarkPairUnavailability(catalog, {
      model: row.model,
      variant: variantFromStorage(row.variant),
    }),
  }));
  await failPendingProfiles(
    env.BENCH_DB,
    current,
    checked.flatMap(({ row, failure }) =>
      failure === null ? [] : [{ model: row.model, variant: row.variant, failure }]
    )
  );
  const available = checked.flatMap(({ row, failure }) => (failure === null ? [row] : []));
  // Queued re-measures of ready rows are reserved ahead of the pending backlog, so an
  // operator's repair starts on the next drain instead of waiting for the backlog.
  const queued = [
    ...remeasures,
    ...available.slice(0, Math.max(0, maxEntries - remeasures.length)),
  ];
  if (queued.length === 0) {
    // Every pending row this drain found is unavailable, so the queue has
    // nothing claimable — the same answer as an empty queue.
    options.skipped?.push('nothing_pending');
    return null;
  }

  const batch = queued.slice(0, maxEntries);
  const entries: RunModelEntry[] = batch.map(row => ({
    model: row.model,
    variant: variantFromStorage(row.variant),
  }));

  try {
    const result = await startRun(env, 'decider', { router, purpose: queue, entries });
    console.log(
      JSON.stringify({
        event: 'benchmark_queue_drain_started',
        queue,
        runId: result.runId,
        entryCount: result.enqueuedModels,
        models: entries.map(e => e.model),
      })
    );
    // The claimed count, not the requested one — a concurrent drain of either
    // queue may have claimed part of this batch between the read and the claim.
    return { runId: result.runId, entryCount: result.enqueuedModels };
  } catch (error) {
    if (error instanceof QueueRunNotAdmittedError) {
      // Another drain won the slot between our read and our insert.
      options.skipped?.push('active_run');
      logQueueDrainSkipped(router, queue, error.occupancy);
      return null;
    }
    if (error instanceof NoEntriesClaimedError) {
      // Concurrent drains claimed this whole batch between our read and our
      // claim. The pairs are being measured; nothing to do.
      options.skipped?.push('nothing_pending');
      console.log(JSON.stringify({ event: 'benchmark_queue_drain_batch_already_claimed', queue }));
      return null;
    }
    throw error;
  }
}

async function initializeScheduledRun(env: Env, runId: string): Promise<boolean> {
  const initialized = await env.BENCH_DB.prepare(
    'SELECT run_id FROM scheduler_runs WHERE run_id = ?'
  )
    .bind(runId)
    .first();
  if (initialized) return true;
  const { run, models } = (await getRunWithModels(env.BENCH_DB, runId)) ?? {};
  if (!run || !models || run.status !== 'running') return false;
  if (!run.admission_marker) {
    // Not admitted by the paid-flow Worker (legacy or deploy-overlap writer): never
    // initialize it, never measure it, and make it terminal so nothing retries.
    await markRunFailed(
      env.BENCH_DB,
      runId,
      'Retired: run was not admitted by the paid benchmark flow.'
    );
    return false;
  }
  // Execution mints each case's token for this identity; only rows written before
  // the org snapshot existed lack one.
  if (!run.benchmark_user_id || !run.benchmark_org_id) {
    const reason = 'Benchmark run is missing its execution identity.';
    await markProfilesFailedForRun(env.BENCH_DB, runId, {
      failureClass: 'run_init_failed',
      reason,
    });
    await markRunFailed(env.BENCH_DB, runId, reason);
    return false;
  }
  const entries = models
    .filter(model => model.enqueued)
    .map(model => ({ model: model.model, variant: variantFromStorage(model.variant) }));
  // A run's first chunk is written only after every entry's reuse committed, so a run
  // without chunks is the only one whose reuse may be missing or partial. The copies
  // skip rows the run already holds, so repeating a failed pass is safe.
  if (!(await hasScheduledChunks(env.BENCH_DB, runId))) {
    const minimumRevisions = minimumCaseRevisions(run.router, run.measurement_revision);
    try {
      await copyRemeasureBaselines(env.BENCH_DB, { runId, minimumRevisions });
      await reuseDeciderCaseResults(env.BENCH_DB, {
        runId,
        router: run.router,
        engineIdentity: run.engine_identity,
        repetitions: run.repetitions,
        entries,
        minimumRevisions,
      });
    } catch (error) {
      await markProfilesFailedForRun(env.BENCH_DB, runId, {
        failureClass: 'run_init_failed',
        reason: `case reuse failed: ${formatError(error).error}`,
      });
      throw error;
    }
  }
  const caseIds = deciderCasesForRouter(run.router, run.measurement_revision).map(
    benchCase => benchCase.id
  );
  // A user-purpose run exists only for an explicit funded request. Its lanes measure
  // the slots that request still has queued (plus whatever reuse already copied), never
  // the whole catalog: nobody admitted those other cases, so inferring them would spend
  // on work no payer asked for.
  let laneCaseIds: Map<string, string[]> | undefined;
  if (run.purpose === 'user') {
    const requestId = paidRequestIdFromRunId(runId);
    const request = requestId ? await readPaidBenchmarkRequest(env.BENCH_DB, requestId) : null;
    if (!request || request.status !== 'active') {
      await markRunFailed(
        env.BENCH_DB,
        runId,
        request
          ? 'Paid benchmark request is no longer active.'
          : 'Paid benchmark request not found.'
      );
      await quarantineProfileClaimsForRuns(env.BENCH_DB, [runId]);
      return false;
    }
    const plan = await listPaidRequestCasePlan(env.BENCH_DB, { requestId: request.id });
    const lanes = new Map<string, string[]>();
    laneCaseIds = lanes;
    const plannedPairs = new Set<string>();
    for (const row of plan) {
      const key = laneKey(row.model, row.variant, row.rep);
      const cases = lanes.get(key) ?? [];
      cases.push(row.case_id);
      lanes.set(key, cases);
      plannedPairs.add(exactPairKey(row.model, variantFromStorage(row.variant)));
    }
    if (laneCaseIds.size === 0) {
      await markRunFailed(
        env.BENCH_DB,
        runId,
        'Paid benchmark request has nothing left to measure.'
      );
      await releaseProfileClaims(env.BENCH_DB, runId);
      return false;
    }
    // The run's snapshot must cover every planned lane; anything else means the request
    // and the run disagree, and measuring a subset would silently under-report.
    const snapshotPairs = new Set(entries.map(e => exactPairKey(e.model, e.variant)));
    for (const pair of plannedPairs) {
      if (!snapshotPairs.has(pair)) {
        await markRunFailed(
          env.BENCH_DB,
          runId,
          'Paid benchmark plan names a pair missing from its run.'
        );
        await quarantineProfileClaimsForRuns(env.BENCH_DB, [runId]);
        return false;
      }
    }
  }
  return scheduleRunChunks(env.BENCH_DB, {
    runId,
    entries,
    repetitions: run.repetitions,
    caseIds,
    chunkSize: DECIDER_CHUNK_SIZE,
    laneCaseIds,
  });
}

/**
 * Advances every uninitialized running decider run by one bounded materialization
 * pass and reports whether any of them finished initializing.
 */
async function initializeScheduledRuns(env: Env): Promise<boolean> {
  const uninitialized = await env.BENCH_DB.prepare(`
    SELECT id FROM benchmark_runs WHERE kind = 'decider' AND status = 'running'
      AND NOT EXISTS (SELECT 1 FROM scheduler_runs WHERE run_id = benchmark_runs.id)
    ORDER BY started_at LIMIT ${REGISTRY_QUEUES}
  `).all<{ id: string }>();
  if (uninitialized.results.length === 0) return false;
  const token = crypto.randomUUID();
  if (!(await acquireInitializationLease(env.BENCH_DB, token, Date.now()))) return false;
  try {
    let initialized = false;
    for (const run of uninitialized.results) {
      try {
        if (await initializeScheduledRun(env, run.id)) initialized = true;
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: 'benchmark_scheduler_initialization_failed',
            runId: run.id,
            ...formatError(error),
          })
        );
      }
    }
    return initialized;
  } finally {
    await releaseInitializationLease(env.BENCH_DB, token);
  }
}

async function dispatchClaims(env: Env, config: SchedulerConfig): Promise<number> {
  const claims = await claimScheduledChunks(env.BENCH_DB, config, Date.now(), crypto.randomUUID());
  for (const [index, claim] of claims.entries()) {
    try {
      await env.BENCH_QUEUE.send({
        runId: claim.run_id,
        kind: 'decider',
        model: claim.model,
        claimId: claim.id,
        claimToken: claim.token,
      });
    } catch (error) {
      for (const unsent of claims.slice(index)) {
        await deferChunk(env.BENCH_DB, unsent.id, unsent.token, Date.now());
      }
      throw error;
    }
  }
  return claims.length;
}

/**
 * Claims for initialized runs before materializing uninitialized ones, so a large run
 * that takes several passes to initialize never holds back other runs' dispatch. A
 * pass that completes a run's initialization claims again to start its chunks.
 */
export async function dispatchScheduler(env: Env): Promise<void> {
  // The cutover comes first and fail-closed: a worker that cannot read the marker must not
  // schedule anything (it cannot tell legacy work from admitted work).
  let cutoverAt: string;
  try {
    cutoverAt = await ensureBenchmarkCutover(env.BENCH_DB);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'benchmark_cutover_unavailable', ...formatError(error) }));
    return;
  }
  // Fence work that predates the cutover before any claim reads it, and fail closed: if the
  // retirement write did not commit, the legacy runs are still `running` and the claim pass
  // below would measure them. Nothing is claimed until a later pass retires them.
  try {
    await retireLegacyRuns(env, cutoverAt);
  } catch (error) {
    console.warn(
      JSON.stringify({ event: 'benchmark_legacy_retire_failed', ...formatError(error) })
    );
    return;
  }
  const { config } = resolveSchedulerConfig(
    env.BENCHMARK_SCHEDULER_CONFIG,
    (await getSchedulerOverrides(env.BENCH_DB)).overrides
  );
  // Deliver cancellation intents whose payer set is already gone, then re-read the chunk
  // fence that recovery may have changed. A failure here must not stop dispatch: the
  // intents are durable and the next pass retries them.
  await deliverPaidCaseCancellations(env).catch(error => {
    console.warn(
      JSON.stringify({ event: 'benchmark_paid_cancellation_pass_failed', ...formatError(error) })
    );
  });
  const failed = await recoverChunks(env.BENCH_DB, Date.now());
  for (const claim of failed) {
    await recordLaneFailure(env.BENCH_DB, {
      runId: claim.run_id,
      model: claim.model,
      variant: claim.variant,
      rep: claim.rep,
      chunk: claim.chunk,
      shard: 0,
      failureClass: 'unknown',
    });
    for (const caseId of z.array(z.string()).parse(JSON.parse(claim.case_ids))) {
      await queueOutputRecovery(env, {
        runId: claim.run_id,
        model: claim.model,
        variant: claim.variant,
        rep: claim.rep,
        caseId,
      });
    }
    await finalizeRunIfComplete(env, claim.run_id, 'decider', await getRunState(env, claim.run_id));
  }
  for (const runId of await listSettledSchedulerRuns(
    env.BENCH_DB,
    REGISTRY_QUEUES * MAX_RUNNING_RUNS_PER_QUEUE
  )) {
    await finalizeRunIfComplete(env, runId, 'decider', await getRunState(env, runId));
  }
  let claimed = await dispatchClaims(env, config);
  if (await initializeScheduledRuns(env)) claimed += await dispatchClaims(env, config);
  console.log(
    JSON.stringify({
      event: 'benchmark_scheduler_dispatched',
      activeSlots: await getLiveContainerLanes(env.BENCH_DB),
      slots: config.slots,
      claimed,
    })
  );
}

/**
 * Retire every decider run without a paid-flow admission marker. Its pending/claimed work
 * is legacy measurement the deploy must not schedule: the run is failed (so no dispatcher
 * claims its chunks and `recoverChunks` completes them) and its registry claims are parked
 * — `pending` with no owner and a pre-cutover `requested_at`, so no drain picks them up and
 * no failure counter moves. Measured rows, summaries and routing artifacts are untouched.
 * Both purposes are fenced: a running platform activation run from before the cutover is
 * exactly the work whose replay must be prevented.
 */
export async function retireLegacyRunsAtCutover(env: Env, cutoverAt: string): Promise<number> {
  return retireLegacyRuns(env, cutoverAt);
}

async function retireLegacyRuns(env: Env, cutoverAt: string): Promise<number> {
  // Legacy writers never stamp a marker. A new run can be admitted before the first
  // scheduler tick records the cutover time, so its timestamp is not admission evidence.
  const legacy = await env.BENCH_DB.prepare(
    `SELECT id FROM benchmark_runs
    WHERE kind = 'decider' AND status = 'running'
      AND admission_marker IS NULL
    ORDER BY started_at LIMIT 50`
  ).all<{ id: string }>();
  if (legacy.results.length === 0) return 0;
  const ids = legacy.results.map(row => row.id);
  await quarantineProfileClaimsForRuns(env.BENCH_DB, ids);
  for (const runId of ids) {
    await markRunFailed(
      env.BENCH_DB,
      runId,
      'Retired: run was not admitted by the paid benchmark flow.'
    );
  }
  console.log(JSON.stringify({ event: 'benchmark_legacy_runs_retired', runIds: ids, cutoverAt }));
  return ids.length;
}

/**
 * Deliver durable cancellation intents to the container that runs them. The payer set and
 * the case run were already fenced in the transaction that wrote the intent, so this pass
 * only signals the actual subprocess; a container that cannot be reached leaves the intent
 * pending for the next pass, and a generation that already stopped is reported delivered.
 *
 * `scope` restricts the pass to the intents one mutation wrote, so a pause (which holds the
 * billing lock and must not take on unrelated work) delivers exactly its own cancellations.
 * It is a small, bounded function: no dispatch, no run start, no claim. A delivery failure
 * only leaves the intent pending — nothing here can create new work.
 */
export async function deliverPaidCaseCancellations(
  env: Env,
  scope: {
    requestId?: string;
    executorRunId?: string;
    createdAfter?: number;
  } = {}
): Promise<{ delivered: number; pending: number }> {
  const intents = await listPendingPaidCancellations(env.BENCH_DB, Date.now(), 32, scope);
  let delivered = 0;
  let pending = 0;
  for (const intent of intents) {
    const variant = intent.variant;
    if (intent.slot === null || intent.attempt_started_at === null) {
      // No active chunk or no ledgered paid call of this generation: there is nothing of
      // ours left running to stop.
      await markPaidCancellationDelivered(env.BENCH_DB, intent, 'nothing_live');
      delivered += 1;
      continue;
    }
    try {
      await cancelDeciderCase(env, {
        instanceName: `benchmark-slot:${intent.slot}`,
        execution: {
          runId: intent.executor_run_id,
          model: intent.model,
          variant,
          rep: intent.rep,
          caseId: intent.case_id,
          token: intent.executor_token,
          attemptStartedAt: intent.attempt_started_at,
        },
      });
      await markPaidCancellationDelivered(env.BENCH_DB, intent);
      delivered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (intent.attempts >= 7) {
        // The container never answered. The generation is already fenced (no payer, no
        // charge) and any late output is recovered separately, so stop retrying.
        await markPaidCancellationDelivered(env.BENCH_DB, intent, `abandoned: ${message}`);
        delivered += 1;
      } else {
        await deferPaidCancellation(env.BENCH_DB, intent, message);
        pending += 1;
      }
    }
  }
  return { delivered, pending };
}

// A container that loses its caller still finishes the paid case, then posts the outcome
// to /container/case-result. Delivery covers the container's own start (at most ~30s)
// and its timed post attempts with backoff (at most ~5.5 minutes, so it outlasts a few
// minutes of D1 overload), with headroom.
const CONTAINER_DELIVERY_WINDOW_MS = 420_000;
export const PAID_OUTPUT_WAIT_MS = DECIDER_CLI_TIMEOUT_MS + CONTAINER_DELIVERY_WINDOW_MS;
const PAID_OUTPUT_RECHECK_MS = 30_000;

class AmbiguousBenchmarkExecutionError extends Error {
  /**
   * Until this time the container may still deliver the paid call's output, so the
   * chunk keeps its slot and provider lease and rechecks instead of failing its lane.
   * A probe has no container and produces its reply in the invocation, so nothing can
   * satisfy that wait and its window is zero.
   */
  readonly outputDeadline: number;

  constructor(paidStartedAt: number, options?: ErrorOptions & { deliveryWindowMs?: number }) {
    super(
      'Previous paid execution has no recoverable output; refusing automatic duplicate inference',
      options
    );
    this.outputDeadline = paidStartedAt + (options?.deliveryWindowMs ?? PAID_OUTPUT_WAIT_MS);
  }
}

class ChunkClaimLostError extends Error {
  constructor() {
    super('The chunk claim can no longer start paid cases');
  }
}

/**
 * Another funded generation owns this case run. Waiting is the only safe action: the
 * owner is measuring it, and a second inference would be a duplicate nobody pays twice
 * for. The chunk defers and reads the fence again.
 */
class PaidCaseAttachedError extends Error {}

/**
 * The case run is terminal without a usable result (a result-less failure, or a
 * settlement that kept no reusable output). It cannot be inferred again at this engine
 * and cannot be adopted, so the lane ends with the failure the admission recorded.
 */
class PaidCaseUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`Paid case run is unavailable: ${reason}`);
  }
}

/**
 * A typed, authenticated refusal from the worker's own case-inference route, or null.
 *
 * Only the route's own error envelope counts: it is the one signal that the payer boundary
 * refused the call *before* any upstream request, so nothing was spent and the case must
 * stop without being graded or retried. A raw provider 402/403 (especially after the route
 * admitted the call) is a provider failure with possible usage — never "no funds".
 */
/**
 * The payer stop carried by this result, from the Worker-origin marker the runner records on
 * the run result (`BENCHMARK_CASE_STOP_HEADER`, never an admitted upstream response and never
 * parsed from text). Absent means the case ended normally, so a provider body that happens to
 * contain the same words can not pause anything. `paused`/`cancelled`/`not_live` arrive
 * through the same channel and are handled by their own branches, not as a funding stop.
 */
function caseInferenceRefusal(result: { stop?: { reason: string } }): 'no_payer' | null {
  // `insufficient_funds` is not a runner stop reason: a refusal caused by balance arrives as
  // the route's own `no_payer` stop (the payer boundary could not fund the call), and the
  // request-side pause reason comes from the same signal.
  return result.stop?.reason === 'no_payer' ? 'no_payer' : null;
}

/**
 * A stop that means the Worker's own billing route could not run (`billing_unavailable`, the
 * case-inference 503 emitted before any payer is chosen). It is not a funding verdict and not
 * a model outcome: nothing was spent, so the case must neither be graded nor pause a request.
 *
 * Classified from the trusted stop marker only. A provider body or stderr text saying the
 * same words can never reach here, which is why there is no text fallback next to it.
 */
function caseInferenceUnavailable(result: { stop?: { reason: string } }): boolean {
  const reason = result.stop?.reason;
  return reason === 'infra_unavailable' || reason === 'billing_unavailable';
}

/** A case stopped because its payer boundary refused the call before any upstream usage. */
class PaidCaseUnfundedError extends Error {
  constructor(readonly code: string) {
    super(`Paid case stopped: ${code}`);
  }
}

/**
 * The billing/gateway route could not run. Nothing was spent and nothing about the model or
 * the payer was learned, so the chunk defers and re-enters normal admission. It is not a
 * lane failure and not a profile attempt: the failure streak must not move.
 */
class BenchmarkInfraUnavailableError extends Error {}

class BenchmarkThrottleError extends Error {}

class BenchmarkCatalogLoadError extends Error {
  constructor(
    message: string,
    readonly category: 'catalog_load' | 'model_resolution'
  ) {
    super(message);
  }
}

class BenchmarkModelUnavailableError extends Error {}

/** The profile failure class a lane killed by a chunk failure records, by wait reason. */
const LANE_FAILURE_CLASS_BY_WAIT_REASON = {
  model_unavailable: 'model_not_found',
  awaiting_output: 'ambiguous_execution',
  ambiguous_execution: 'ambiguous_execution',
  catalog_load: 'catalog_load',
  probe_family: 'unsupported',
  model_resolution: 'model_resolution',
  grading: 'grader',
  container_capacity: 'container_capacity',
  provider_throttle: 'provider_unavailable',
  infrastructure: 'unknown',
  claim_lost: 'unknown',
  paid_case_unavailable: 'unknown',
  infra_unavailable: 'unknown',
} as const satisfies Record<string, BenchmarkProfileFailureClass>;

export const PROFILE_MODEL_UNAVAILABLE_FAILURE_REASON =
  'Exact benchmark model or variant is unavailable to the benchmark CLI; retry after availability is restored.';

/**
 * The trusted Worker stop a container may post back. Declared here because zod drops unknown
 * keys: without it the posted stop never reaches `parseContainerRunResponse`, the callback gate
 * is dead code, and a pre-admission stop would be persisted as gradeable pending output.
 */
const ContainerStopSchema = z.object({
  reason: z.enum([
    'paused',
    'no_payer',
    'cancelled',
    'not_live',
    'infra_unavailable',
    'model_permanently_failed',
  ]),
  status: z.number().int(),
});

const ContainerCaseResultSchema = z.object({
  execution: z.object({
    runId: z.string(),
    model: z.string(),
    variant: z.string(),
    rep: z.number().int(),
    caseId: z.string(),
    token: z.string(),
    attemptStartedAt: z.number().int().nonnegative().optional(),
    retried: z.boolean().optional(),
    priorCostUsd: z.number().nonnegative().nullable().optional(),
    priorUsage: z
      .object({
        inputTokens: z.number().nonnegative().nullable(),
        cachedInputTokens: z.number().nonnegative().nullable(),
        outputTokens: z.number().nonnegative().nullable(),
        reasoningTokens: z.number().nonnegative().nullable(),
      })
      .nullable()
      .optional(),
  }),
  outcome: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('completed'),
      response: z.object({
        exitCode: z.number(),
        durationMs: z.number(),
        stdoutLines: z.array(z.string()),
        stderrTail: z.string(),
        timedOut: z.boolean().optional(),
        stop: ContainerStopSchema.optional(),
      }),
    }),
    z.object({ kind: z.literal('not_started') }),
    // A cancel that reached a subprocess (a payer pause): the CLI already stopped. Output
    // it produced before the stop is delivered as reusable data; a spawn that produced
    // nothing is not.
    z.object({
      kind: z.literal('cancelled'),
      spawned: z.boolean(),
      response: z
        .object({
          exitCode: z.number(),
          durationMs: z.number(),
          stdoutLines: z.array(z.string()),
          stderrTail: z.string(),
          timedOut: z.boolean().optional(),
          stop: ContainerStopSchema.optional(),
        })
        .optional(),
    }),
  ]),
});

type OutputRecoveryKey = {
  runId: string;
  model: string;
  variant: string;
  rep: number;
  caseId: string;
};

async function queueOutputRecovery(env: Env, execution: OutputRecoveryKey): Promise<void> {
  const key = {
    run_id: execution.runId,
    model: execution.model,
    variant: execution.variant,
    rep: execution.rep,
    case_id: execution.caseId,
  };
  if (!(await needsPendingOutputRecovery(env.BENCH_DB, key))) return;
  await env.BENCH_QUEUE.send({
    runId: execution.runId,
    kind: 'decider',
    model: execution.model,
    variant: variantFromStorage(execution.variant),
    rep: execution.rep,
    caseIds: [execution.caseId],
    recoverOutput: true,
  } satisfies BenchmarkJobMessage);
}

async function recordDeciderOutput(
  env: Env,
  key: OutputRecoveryKey,
  benchCase: MeasuredCase,
  output: StoredDeciderOutput,
  judge: DeciderJudge | null,
  engineIdentity: string
): Promise<number> {
  const pendingKey = {
    run_id: key.runId,
    model: key.model,
    variant: key.variant,
    rep: key.rep,
    case_id: key.caseId,
  };
  const gradingToken = crypto.randomUUID();
  if (!(await claimDeciderGrading(env.BENCH_DB, pendingKey, gradingToken, Date.now()))) {
    const existing = await getExistingCaseResultIds(env.BENCH_DB, {
      runId: key.runId,
      model: key.model,
      variant: variantFromStorage(key.variant),
      rep: key.rep,
      caseIds: [key.caseId],
    });
    if (existing.has(key.caseId)) return 0;
    throw new DeciderGraderRetryError('This case is already being graded.');
  }
  try {
    const { result, retried } = output;
    let grade: { score: number | null; costUsd: number; graderError: string | null };
    if (isProbeCase(benchCase)) {
      // A probe has no prompt to re-grade: the reply either continues the task (a tool
      // call), states the correct final answer, or stops.
      grade = {
        score:
          result.exitCode === 0
            ? gradeProbeOutput(benchCase.check, {
                text: result.text,
                toolCalls: result.tools?.calls ?? 0,
              })
            : 0,
        costUsd: 0,
        graderError: null,
      };
    } else {
      const answered =
        result.exitCode === 0 &&
        result.text.length > 0 &&
        !lacksRequiredToolCalls(benchCase.requiredToolCalls, result.tools?.calls ?? null);
      grade = answered
        ? await gradeDeciderOutput(benchCase.check, {
            userPrompt: benchCase.userPrompt,
            output: result.text,
            judge,
          })
        : { score: 0, costUsd: 0, graderError: null };
    }
    if (grade.score === null) {
      throw new DeciderGraderRetryError(grade.graderError ?? 'Decider judge failed');
    }
    // The canonical case run settles in the same D1 transaction as this result: the
    // running→settled transition and `result_usable` commit with the graded row or not at
    // all, so a settled case run never exists without usable data. Billing is charged just
    // in time per model request by the gateway, so no payer split or charge happens here.
    // An adopted result (executed by another run) resolves to no generation and only
    // writes the row.
    const caseKey: PaidCaseKey = {
      engineIdentity,
      model: key.model,
      variant: key.variant,
      rep: key.rep,
      caseId: key.caseId,
    };
    const generation = await readOwnedCaseGeneration(env.BENCH_DB, key.runId, caseKey);
    const settlement = generation
      ? completePaidCaseStatements(env.BENCH_DB, {
          key: caseKey,
          generation,
          // Reuse eligibility: a successful exit that did not time out. A wrong answer is a
          // valid measurement, and stderr diagnostics on a successful exit do not void it.
          resultUsable: result.exitCode === 0 && !result.timedOut,
          settlementId: crypto.randomUUID(),
        })
      : [];
    const results = await upsertCaseResult(
      env.BENCH_DB,
      {
        run_id: key.runId,
        model: key.model,
        variant: key.variant,
        case_id: key.caseId,
        route_key: taxonomyRouteKey(benchCase),
        score: grade.score,
        latency_ms: result.latencyMs,
        cost_usd: result.costUsd,
        input_tokens: result.inputTokens,
        cached_input_tokens: result.cachedInputTokens,
        output_tokens: result.outputTokens,
        reasoning_tokens: result.reasoningTokens,
        error: result.exitCode !== 0 ? result.stderrTail.slice(0, 500) : null,
        fallback_reason: null,
        route_hit: null,
        retried,
        exit_code: result.exitCode,
        output_prefix: result.text.slice(0, 200),
        event_count: result.eventCount,
        last_event_types: result.lastEventTypes.join(' '),
        tool_calls: result.tools?.calls ?? null,
        tool_names: result.tools ? JSON.stringify(result.tools.names) : null,
        step_count: result.tools?.steps ?? null,
        final_finish_reason: result.tools?.finalFinishReason ?? null,
        rep: key.rep,
        timed_out: result.timedOut ? 1 : 0,
        prompt_revision: output.promptRevision,
      },
      settlement
    );
    if (generation && (results[2]?.meta.changes ?? 0) === 0) {
      // The generation stopped being `running` before this result landed (a pause or an
      // admin cancel fenced it, or another consumer settled it). `completePaidCaseStatements`
      // then only raises `result_usable` on the terminal row: the late output stays reusable
      // data and nothing reopens the case run.
      console.log(
        JSON.stringify({
          event: 'benchmark_late_paid_case_result',
          runId: key.runId,
          caseId: key.caseId,
        })
      );
    }
    return grade.costUsd;
  } finally {
    await releaseDeciderGrading(env.BENCH_DB, pendingKey, gradingToken);
  }
}

async function recoverPendingOutputJob(env: Env, message: BenchmarkJobMessage): Promise<void> {
  const caseId = message.caseIds?.[0];
  if (caseId === undefined || message.caseIds?.length !== 1 || message.rep === undefined) {
    throw new Error('Output recovery requires one case and a repetition.');
  }
  const state = await getRunState(env, message.runId);
  if (state.engineIdentity !== computeEngineIdentity('decider', state.router)) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_output_recovery_deferred',
        runId: message.runId,
        model: message.model,
        variant: variantToStorage(message.variant),
        rep: message.rep,
        caseId,
        reason: 'engine_changed',
      })
    );
    return;
  }
  const variant = variantToStorage(message.variant);
  const benchCase = deciderCasesForRouter(state.router, state.measurementRevision).find(
    candidate => candidate.id === caseId
  );
  if (
    !benchCase ||
    !state.models.some(row => row.model === message.model && row.variant === variant)
  ) {
    throw new Error('Output recovery does not match the run snapshot.');
  }
  const key = {
    run_id: message.runId,
    model: message.model,
    variant,
    case_id: caseId,
    rep: message.rep,
  };
  const existing = await getExistingCaseResultIds(env.BENCH_DB, {
    runId: message.runId,
    model: message.model,
    variant: message.variant ?? null,
    rep: message.rep,
    caseIds: [caseId],
  });
  if (existing.has(caseId)) {
    await deletePendingDeciderOutput(env.BENCH_DB, key);
    return;
  }
  const skipRecovery = (reason: string) =>
    console.warn(
      JSON.stringify({
        event: 'benchmark_output_recovery_skipped',
        runId: message.runId,
        model: message.model,
        variant,
        rep: message.rep,
        caseId,
        reason,
      })
    );
  if (!(await needsPendingOutputRecovery(env.BENCH_DB, key))) {
    skipRecovery('not_recoverable');
    return;
  }
  const pending = await getPendingDeciderOutput(env.BENCH_DB, key);
  if (!pending) {
    skipRecovery('pending_output_missing');
    return;
  }
  if (isExactModelUnavailableResult(pending.result, message.model)) {
    skipRecovery('model_unavailable');
    return;
  }
  if (
    isCatalogLoadFailureResult(pending.result) ||
    isUnsupportedModelResult(pending.result, message.model) ||
    isUnbilledTransientProviderResult(pending.result)
  ) {
    await deletePendingDeciderOutput(env.BENCH_DB, key);
    skipRecovery(
      isCatalogLoadFailureResult(pending.result)
        ? 'catalog_load'
        : isUnsupportedModelResult(pending.result, message.model)
          ? 'model_resolution'
          : 'provider_throttle'
    );
    return;
  }
  const judge =
    benchCase.check.kind === 'judged' ? createDeciderJudge(await createSystemOneClient(env)) : null;
  const graderCostUsd = await recordDeciderOutput(
    env,
    { runId: message.runId, model: message.model, variant, rep: message.rep, caseId },
    benchCase,
    pending,
    judge,
    state.engineIdentity
  );
  console.log(
    JSON.stringify({
      event: 'benchmark_late_output_graded',
      runId: message.runId,
      model: message.model,
      variant,
      rep: message.rep,
      caseId,
      runStatus: state.status,
      graderCostUsd,
    })
  );
}

export function benchmarkErrorCategory(error: unknown): string {
  const root = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const message = root instanceof Error ? root.message : '';
  const status = /\bHTTP (\d{3})\b/.exec(message)?.[1] ?? 'unknown';
  if (message.startsWith('token mint failed')) return `token_mint_http_${status}`;
  if (message.startsWith('token mint returned')) return 'token_mint_response_shape';
  if (message.startsWith('benchmark executable model catalog failed')) {
    return `catalog_http_${status}`;
  }
  if (message.includes(CONTAINER_NOT_REACHED_PREFIX)) return 'container_not_reached';
  if (message.startsWith('container /run failed')) return `container_run_http_${status}`;
  if (message.startsWith('container /warmup failed')) return `container_warmup_http_${status}`;
  if (message.includes('D1_ERROR')) return 'd1_error';
  if (message.includes('has no benchmarkOrgId')) return 'benchmark_org_missing';
  if (message.includes('has no snapshot row')) return 'run_snapshot_mismatch';
  if (message.includes('Output recovery')) return 'output_recovery_contract';
  return 'unclassified';
}
// Only the execution that opened a case may acknowledge its durable output.
export async function acceptContainerCaseResult(env: Env, body: unknown): Promise<boolean> {
  const parsed = ContainerCaseResultSchema.safeParse(body);
  if (!parsed.success) {
    console.warn(
      JSON.stringify({ event: 'benchmark_container_result_rejected', reason: 'invalid_shape' })
    );
    return false;
  }
  const { execution, outcome } = parsed.data;
  const correlation = {
    runId: execution.runId,
    model: execution.model,
    variant: execution.variant,
    rep: execution.rep,
    caseId: execution.caseId,
    attemptStartedAt: execution.attemptStartedAt ?? null,
    retried: execution.retried ?? false,
    outcome: outcome.kind,
  };
  // The container was spawned by whatever worker opened the paid call, which may have run
  // the previous transport. Stamp its output with that revision, not this deploy's.
  const promptRevision = await getPaidCasePromptRevision(env.BENCH_DB, execution);
  if (promptRevision === null) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_container_result_rejected',
        ...correlation,
        reason: 'execution_generation_not_found',
      })
    );
    return false;
  }
  let stored = false;
  // Billing is just in time per model request, so there is no hold to refund and no charge
  // to reverse here: a spawned cancel is not proof that nothing was billed (the in-flight
  // gateway request may have consumed usage), so its attribution stays until the case
  // settles or is cancelled. Only an affirmative pre-spawn `not_started` gives the launch
  // fence's proof that nothing was admitted, and only that clears the ledger row.
  const response =
    outcome.kind === 'completed'
      ? outcome.response
      : outcome.kind === 'cancelled' && outcome.spawned
        ? outcome.response
        : undefined;
  if (outcome.kind === 'not_started') {
    await clearUnbilledCase(env.BENCH_DB, execution);
  } else if (!response) {
    // Spawned and cancelled without a parsed answer: keep the attribution (a native receipt
    // may still exist upstream) and record nothing.
    console.log(
      JSON.stringify({
        event: 'benchmark_container_result_unmeasured',
        ...correlation,
        promptRevision,
      })
    );
    return true;
  } else {
    const result = parseContainerRunResponse(response, Date.now(), execution.model);
    // A container-posted answer can carry the same trusted Worker stop. An infrastructure
    // stop is not a measurement: it must not become gradeable pending output, and the ledger
    // row stays because reachability is unknown (the request may still be admitted). A
    // `no_payer` stop likewise never grades; the canonical pause is driven from the runner's
    // own classification, so nothing is written here either.
    if (result.stop !== undefined) {
      console.log(
        JSON.stringify({
          event: 'benchmark_container_result_stopped',
          ...correlation,
          promptRevision,
          stopReason: result.stop.reason,
        })
      );
      return true;
    }
    if (execution.retried) {
      addPriorAttempt(result, {
        costUsd: execution.priorCostUsd ?? null,
        inputTokens: execution.priorUsage?.inputTokens ?? null,
        cachedInputTokens: execution.priorUsage?.cachedInputTokens ?? null,
        outputTokens: execution.priorUsage?.outputTokens ?? null,
        reasoningTokens: execution.priorUsage?.reasoningTokens ?? null,
      });
    }
    stored = await savePendingDeciderOutput(
      env.BENCH_DB,
      {
        run_id: execution.runId,
        model: execution.model,
        variant: execution.variant,
        case_id: execution.caseId,
        rep: execution.rep,
      },
      {
        result,
        retried: execution.retried ?? false,
        attemptStartedAt: execution.attemptStartedAt,
        promptRevision,
      },
      execution
    );
    await queueOutputRecovery(env, execution);
  }
  console.log(
    JSON.stringify({
      event: 'benchmark_container_result_persisted',
      ...correlation,
      promptRevision,
      stored,
    })
  );
  return true;
}

/**
 * Kill a lane that can never measure its pair, and terminalize the paid links waiting on it,
 * in ONE D1 batch.
 *
 * `failScheduledEntry` used to commit on its own and the money-side write was best-effort
 * afterwards: because the chunk's attempts are already spent at that point, a rejected second
 * write stranded an active request on a case nobody could ever measure. Both write sets now
 * carry the same owned-claim fence and commit together, so the two states can never disagree.
 *
 * On failure nothing is written: the chunk keeps its active lease, `recoverChunks` re-enters
 * this same path on a later pass, and the metadata commit happens then. That retry only
 * replays bookkeeping — the case's output is already durable, so no paid inference is issued
 * again.
 */
async function failDeadLaneAndPaidLinks(
  env: Env,
  claim: SchedulerClaim,
  failureClass: BenchmarkProfileFailureClass,
  reason: string,
  transitionPrefix: string
): Promise<void> {
  const state = await getRunState(env, claim.run_id);
  // The transition id names the exact lane that writes it (claim id + token), so a different
  // claim's terminal pass can never match this generation's rows even if it targets the same
  // pair. Bounded: the claim id and token are short-lived identifiers the scheduler already
  // stores verbatim.
  const transitionId = [
    transitionPrefix,
    claim.run_id,
    claim.model,
    claim.variant,
    claim.id,
    claim.token,
  ].join(':');
  // The paid statements go FIRST and carry the same owned-claim fence, so a stale claim that
  // lost the lane writes nothing at all: if `id`/`token` are no longer the active owner, both
  // paid updates match zero rows, and the lane death that follows matches zero too. Ordering
  // also means the link terminalization reads the live chunk state it is fenced on.
  await env.BENCH_DB.batch([
    ...failPaidCasesForUnavailablePairStatements(env.BENCH_DB, {
      engineIdentity: state.engineIdentity,
      model: claim.model,
      variant: claim.variant,
      reason,
      transitionId,
      claim: { id: claim.id, token: claim.token },
    }),
    ...failScheduledEntryStatements(env.BENCH_DB, claim, failureClass),
  ]);
}

async function processScheduledChunk(
  env: Env,
  id: string,
  token: string,
  ctx?: SecretsExecutionContext
): Promise<void> {
  const claim = await getChunk(env.BENCH_DB, id, token);
  if (!claim) return;
  if (!(await startChunk(env.BENCH_DB, id, token, Date.now()))) return;
  let state: RunState | undefined;
  try {
    state = await getRunState(env, claim.run_id);
    // An already-delivered queue message can outlive the deploy that scheduled it, so the
    // claim itself re-checks the cutover: a run that started before it is finished here
    // without a container, a provider call or a lane failure.
    const runAdmitted = await env.BENCH_DB.prepare(
      'SELECT admission_marker FROM benchmark_runs WHERE id = ?'
    )
      .bind(claim.run_id)
      .first<{ admission_marker: string | null }>();
    const cutoverAt = await readBenchmarkCutover(env.BENCH_DB);
    if (cutoverAt === null || !runAdmitted?.admission_marker) {
      await markRunFailed(
        env.BENCH_DB,
        claim.run_id,
        'Retired: run was not admitted by the paid benchmark flow.'
      ).catch(() => {});
      await finishChunk(env.BENCH_DB, id, token).catch(() => {});
      console.log(
        JSON.stringify({
          event: 'benchmark_legacy_claim_fenced',
          runId: claim.run_id,
          chunk: claim.chunk,
          cutoverAt,
        })
      );
      return;
    }
    await processDeciderJob(
      env,
      {
        runId: claim.run_id,
        kind: 'decider',
        model: claim.model,
        variant: variantFromStorage(claim.variant),
        rep: claim.rep,
        chunk: claim.chunk,
        caseIds: z.array(z.string()).parse(JSON.parse(claim.case_ids)),
      },
      state,
      claim,
      ctx
    );
    await finishChunk(env.BENCH_DB, id, token);
  } catch (error) {
    const outputDeadline =
      error instanceof AmbiguousBenchmarkExecutionError ? error.outputDeadline : null;
    const awaitingOutput = outputDeadline !== null && Date.now() < outputDeadline;
    const reason =
      error instanceof BenchmarkModelUnavailableError
        ? 'model_unavailable'
        : error instanceof ChunkClaimLostError
          ? 'claim_lost'
          : error instanceof BenchmarkProbeFamilyError
            ? 'probe_family'
            : error instanceof BenchmarkInfraUnavailableError
              ? 'infra_unavailable'
              : error instanceof PaidCaseUnavailableError
                ? 'paid_case_unavailable'
                : awaitingOutput
                  ? 'awaiting_output'
                  : error instanceof AmbiguousBenchmarkExecutionError
                    ? 'ambiguous_execution'
                    : error instanceof BenchmarkCatalogLoadError
                      ? error.category
                      : error instanceof DeciderGraderRetryError
                        ? 'grading'
                        : isRetryableContainerAvailabilityError(error)
                          ? 'container_capacity'
                          : error instanceof BenchmarkThrottleError
                            ? 'provider_throttle'
                            : 'infrastructure';
    if (error instanceof BenchmarkModelUnavailableError) {
      await markProfilesFailedForEntries(
        env.BENCH_DB,
        claim.run_id,
        [{ model: claim.model, variant: claim.variant }],
        { failureClass: 'model_not_found', reason: PROFILE_MODEL_UNAVAILABLE_FAILURE_REASON }
      );
      // A permanently unavailable lane must not leave a paid request waiting on cases that
      // can never be measured: the lane death and the link terminalization commit together.
      await failDeadLaneAndPaidLinks(
        env,
        claim,
        'model_not_found',
        PROFILE_MODEL_UNAVAILABLE_FAILURE_REASON,
        'unavailable'
      );
    } else if (error instanceof BenchmarkProbeFamilyError) {
      // No amount of retrying builds a request this worker can send, and the pair must not
      // reach `ready` with probe results missing: it fails with the exact reason.
      await markProfilesFailedForEntries(
        env.BENCH_DB,
        claim.run_id,
        [{ model: claim.model, variant: claim.variant }],
        { failureClass: 'unsupported', reason: error.reason }
      );
      await failDeadLaneAndPaidLinks(env, claim, 'unsupported', error.reason, 'unsupported');
    } else if (error instanceof ChunkClaimLostError) {
      await deferChunk(env.BENCH_DB, id, token, Date.now());
    } else if (error instanceof PaidCaseAttachedError) {
      // Another funded generation owns this case run. Nothing was inferred, so the chunk
      // waits out a short backoff and re-reads the fence; the owner's result is adopted
      // when it lands and no attempt is consumed by the waiting.
      const delaySeconds = schedulerBackoffSeconds(1);
      await deferChunk(env.BENCH_DB, id, token, Date.now() + delaySeconds * 1000);
      await env.BENCH_QUEUE.send(
        { runId: claim.run_id, kind: 'decider', model: claim.model, schedulerWake: true },
        { delaySeconds }
      );
    } else if (error instanceof BenchmarkInfraUnavailableError) {
      // Infrastructure, not the model or the payer: back the lane off and re-enter normal
      // admission. No lane failure, no catalog cooldown, no profile attempt.
      const delaySeconds = schedulerBackoffSeconds(1);
      await deferChunk(env.BENCH_DB, id, token, Date.now() + delaySeconds * 1000);
      await env.BENCH_QUEUE.send(
        { runId: claim.run_id, kind: 'decider', model: claim.model, schedulerWake: true },
        { delaySeconds }
      );
    } else if (error instanceof BenchmarkCaseNotStartedError) {
      // The launch fence refused the paid start: no provider request and no subprocess.
      // The lane takes a normal backoff and re-admits through the fence; this is never
      // counted as an attempt and never replayed as the user's paid start.
      await deferChunk(env.BENCH_DB, id, token, Date.now() + schedulerBackoffSeconds(1) * 1000);
      await env.BENCH_QUEUE.send(
        { runId: claim.run_id, kind: 'decider', model: claim.model, schedulerWake: true },
        { delaySeconds: schedulerBackoffSeconds(1) }
      );
    } else if (awaitingOutput) {
      await env.BENCH_QUEUE.send(
        {
          runId: claim.run_id,
          kind: 'decider',
          model: claim.model,
          claimId: id,
          claimToken: token,
        },
        {
          delaySeconds: Math.ceil(
            Math.min(PAID_OUTPUT_RECHECK_MS, outputDeadline - Date.now()) / 1000
          ),
        }
      );
    } else if (
      error instanceof BenchmarkThrottleError &&
      claim.throttle_deferrals < SCHEDULER_MAX_THROTTLE_DEFERRALS
    ) {
      const delaySeconds = schedulerBackoffSeconds(claim.throttle_deferrals + 1);
      await deferThrottledChunk(env.BENCH_DB, id, token, Date.now() + delaySeconds * 1000);
      await cooldownModel(env.BENCH_DB, claim.model, Date.now() + delaySeconds * 1000);
      await env.BENCH_QUEUE.send(
        { runId: claim.run_id, kind: 'decider', model: claim.model, schedulerWake: true },
        { delaySeconds }
      );
    } else if (
      error instanceof BenchmarkCatalogLoadError &&
      error.category === 'catalog_load' &&
      claim.catalog_deferrals < SCHEDULER_MAX_CATALOG_DEFERRALS
    ) {
      const delaySeconds = schedulerBackoffSeconds(claim.catalog_deferrals + 1);
      await deferCatalogChunk(env.BENCH_DB, id, token, Date.now() + delaySeconds * 1000);
      await cooldownCatalog(env.BENCH_DB, Date.now() + delaySeconds * 1000);
      await env.BENCH_QUEUE.send(
        { runId: claim.run_id, kind: 'decider', model: claim.model, schedulerWake: true },
        { delaySeconds }
      );
    } else if (
      error instanceof AmbiguousBenchmarkExecutionError ||
      claim.attempts >= SCHEDULER_MAX_ATTEMPTS
    ) {
      await failChunk(env.BENCH_DB, id, token);
      await recordLaneFailure(env.BENCH_DB, {
        runId: claim.run_id,
        model: claim.model,
        variant: claim.variant,
        rep: claim.rep,
        chunk: claim.chunk,
        shard: 0,
        failureClass: LANE_FAILURE_CLASS_BY_WAIT_REASON[reason],
      });
      for (const caseId of z.array(z.string()).parse(JSON.parse(claim.case_ids))) {
        await queueOutputRecovery(env, {
          runId: claim.run_id,
          model: claim.model,
          variant: claim.variant,
          rep: claim.rep,
          caseId,
        });
      }
    } else {
      const delaySeconds = schedulerBackoffSeconds(claim.attempts);
      await deferChunk(env.BENCH_DB, id, token, Date.now() + delaySeconds * 1000);
      if (error instanceof BenchmarkThrottleError) {
        await cooldownModel(env.BENCH_DB, claim.model, Date.now() + delaySeconds * 1000);
      }
      await env.BENCH_QUEUE.send(
        {
          runId: claim.run_id,
          kind: 'decider',
          model: claim.model,
          schedulerWake: true,
        },
        { delaySeconds }
      );
    }
    console.warn(
      JSON.stringify({
        event: 'benchmark_scheduler_wait',
        runId: claim.run_id,
        model: claim.model,
        variant: claim.variant,
        rep: claim.rep,
        chunk: claim.chunk,
        caseIds: z.array(z.string()).parse(JSON.parse(claim.case_ids)),
        slot: claim.slot,
        paidOutputDeadline: outputDeadline,
        waitingForOutput: awaitingOutput,
        attempt: claim.attempts,
        reason,
        errorType: error instanceof Error ? error.name : 'unknown',
        errorCategory: benchmarkErrorCategory(error),
      })
    );
  }
  await dispatchScheduler(env);
  // Run accounting reads every case result of the run, so it only runs once the
  // run's scheduled work has settled. Dispatch's settled-run sweep and the
  // dead-letter path stay responsible for settling runs that never complete.
  if (state && !(await hasUnsettledChunks(env.BENCH_DB, claim.run_id))) {
    await finalizeRunIfComplete(env, claim.run_id, 'decider', state);
  }
}

export async function processJob(
  env: Env,
  rawMessage: unknown,
  ctx?: SecretsExecutionContext
): Promise<void> {
  // Validate the message shape; malformed messages are logged and dropped
  // rather than retried forever.
  const parsed = BenchmarkJobMessageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_job_invalid_message',
        category: 'invalid_job_shape',
      })
    );
    return;
  }

  const message = parsed.data;
  if (message.kind === 'decider') {
    if (message.recoverOutput) {
      await recoverPendingOutputJob(env, message);
      return;
    }
    if (message.schedulerWake) {
      await dispatchScheduler(env);
      return;
    }
    if (message.claimId && message.claimToken) {
      await processScheduledChunk(env, message.claimId, message.claimToken, ctx);
    } else {
      const legacyState = await getRunState(env, message.runId);
      if (legacyState.status === 'running') await initializeScheduledRun(env, message.runId);
      const legacyVariants =
        message.variant !== undefined
          ? [message.variant]
          : legacyState.models
              .filter(row => row.model === message.model)
              .map(row => variantFromStorage(row.variant));
      for (const variant of legacyVariants) {
        await destroyDeciderCliContainer(env, {
          instanceName: getDeciderContainerInstanceName({ ...message, variant }),
        }).catch(error => {
          console.warn(
            JSON.stringify({
              event: 'benchmark_legacy_container_destroy_failed',
              runId: message.runId,
              ...formatError(error),
            })
          );
        });
      }
      await dispatchScheduler(env);
    }
    return;
  }
  const state = await getRunState(env, message.runId);
  if (state.status !== 'running') {
    if (message.kind === 'classifier' && state.status === 'completed') {
      await finalizeRunIfComplete(env, message.runId, message.kind, state);
      return;
    }
    return;
  }

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

    // Create the System One client inside processJob — no module-scope transport clients.
    const client = await createSystemOneClient(env);
    const caseIds = new Set(message.caseIds);
    const rep = message.rep;
    const expandedItems = CLASSIFIER_CASES.filter(benchCase => caseIds.has(benchCase.id)).map(
      benchCase => ({ benchCase, rep })
    );
    const classifierVariant = variantToStorage(message.variant);
    await runCasesWithConcurrency(
      expandedItems,
      BENCHMARK_CLASSIFIER_PARALLELISM,
      async ({ benchCase, rep }) => {
        const startedAt = performance.now();
        try {
          const { cost, classification } = await classifyWithSystemOne(
            client,
            benchCase.input,
            message.model
          );
          await upsertCaseResult(env.BENCH_DB, {
            run_id: message.runId,
            model: message.model,
            variant: classifierVariant,
            case_id: benchCase.id,
            route_key: null,
            score: gradeClassifierOutput(benchCase.expected, classification),
            latency_ms: Math.round(performance.now() - startedAt),
            cost_usd: cost,
            input_tokens: null,
            cached_input_tokens: null,
            output_tokens: null,
            reasoning_tokens: null,
            error: null,
            fallback_reason: null,
            route_hit:
              classification.taskType === benchCase.expected.taskType &&
              classification.subtaskType === benchCase.expected.subtaskType,
            retried: null,
            exit_code: null,
            output_prefix: null,
            event_count: null,
            last_event_types: null,
            tool_calls: null,
            tool_names: null,
            step_count: null,
            final_finish_reason: null,
            rep,
            timed_out: 0,
            prompt_revision: state.measurementRevision,
          });
        } catch (error) {
          await upsertCaseResult(
            env.BENCH_DB,
            failedRow(message, benchCase.id, null, startedAt, error, rep, state.measurementRevision)
          );
        }
      }
    );
  }

  await finalizeRunIfComplete(env, message.runId, message.kind, state);
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
        category: 'invalid_deadletter_shape',
      })
    );
    return;
  }

  const message = parsed.data;
  if (message.kind === 'decider') {
    if (message.claimId && message.claimToken) {
      await deferChunk(env.BENCH_DB, message.claimId, message.claimToken, Date.now(), true);
    }
    if (!message.claimId && !message.schedulerWake) {
      const state = await getRunState(env, message.runId).catch(() => null);
      if (state?.status === 'running') await initializeScheduledRun(env, message.runId);
    }
    await dispatchScheduler(env);
    return;
  }
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
    failureClass: 'unknown',
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
  router: AutoRouter;
  status: RunRow['status'];
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
  engineIdentity: string;
  measurementRevision: number;
};

async function getRunState(env: Env, runId: string): Promise<RunState> {
  // Snapshots taken at startRun time so a mid-run admin edit can't skew them.
  const result = await getRunWithModels(env.BENCH_DB, runId);
  if (!result) throw new Error(`unknown run ${runId}`);
  const { run, models } = result;
  return {
    router: run.router ?? 'efficient',
    status: run.status,
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
    engineIdentity: run.engine_identity,
    measurementRevision: run.measurement_revision,
  };
}

type PaidCaseStart =
  | { kind: 'started'; generation: PaidCaseGeneration }
  | { kind: 'reused' }
  | { kind: 'cancelled' }
  | { kind: 'attached' };

/**
 * The case-scoped inference transport for one paid generation, or null when the worker has
 * no internal secret to sign with (the caller then refuses the paid start rather than
 * sending a request the gateway cannot attribute to a payer).
 *
 * Every provider invocation carries this envelope — platform-covered runs included — so the
 * gateway bills exactly one case generation and the CLI holds no payer credential. Only the
 * exact catalog read routes use the platform bot token.
 */
async function caseInferenceProxy(
  env: Env,
  input: {
    engineIdentity: string;
    runId: string;
    model: string;
    variant: string;
    caseId: string;
    rep: number;
    generation: number;
    startedAt: number;
    /**
     * The CLI's `kilo-gateway` token, which the proxy forwards only to the gateway's catalog
     * reads; `null` for a probe, which makes no catalog read through the proxy.
     */
    catalogToken: string | null;
    kiloApiUrl: string;
  },
  ctx?: SecretsExecutionContext
): Promise<CaseInferenceProxy> {
  const secret = await readAutoRoutingBenchmarkSecret(env, 'INTERNAL_API_SECRET', ctx);
  if (!secret) throw new Error('benchmark case inference secret is unavailable');
  const issued = await issueCaseInferenceCapability(secret, {
    engineIdentity: input.engineIdentity,
    runId: input.runId,
    model: input.model,
    variant: input.variant,
    caseId: input.caseId,
    repetition: input.rep,
    generation: input.generation,
    startedAt: input.startedAt,
  });
  return {
    url: new URL(BENCHMARK_CASE_INFERENCE_PATH, env.BENCH_RESULT_URL).toString(),
    authorization: issued.authorization,
    invocation: issued.invocationHeader,
    invocationHeader: BENCHMARK_CASE_HEADER,
    ...(input.catalogToken === null
      ? {}
      : { catalog: { url: input.kiloApiUrl, authorization: `Bearer ${input.catalogToken}` } }),
  };
}

/**
 * Open the global case run for this exact slot and report whether this invocation may
 * infer.
 *
 * The claim batch (CaseStore's `claimPaidCaseStatements`) writes the case run's
 * running/generation transition and the paid-call ledger row in one D1 transaction, so a
 * crash cannot leave either a claimed case nobody measures or a paid attempt nobody
 * claimed.
 *
 * The grant is read from the batch's own `meta.changes`, never from the executor token: a
 * redelivered chunk carries the same token, and treating a token match as ownership is how
 * two invocations would both infer. The ledger row's start value disambiguates our own
 * claim (`now`) from one a previous invocation left in flight (anything earlier), which is
 * the only case that must wait for its durable output.
 *
 * A user-purpose run never creates a case run: only an explicit paid request enqueues one,
 * so a missing or foreign row means this run must not spend on the case.
 */

/**
 * Return a known-unbilled generation to the queue and clear its scheduler ledger in one D1
 * batch, so the two states can never disagree.
 *
 * CaseStore's release statement is guarded by native proof (no recorded or attempted model
 * request for this generation), so it can refuse. The ledger deletes are conditioned on the
 * `queued` post-state that release itself writes, which means:
 * - release refused → the case run is still `running` under our token → the deletes match
 *   nothing → the ledger row survives, the case is quarantined and nothing is re-executed;
 * - release committed → the case run is `queued` with no executor at this exact generation →
 *   the deletes match in the same transaction.
 * A crash cannot split them: either the whole batch commits or none of it does.
 */
async function releaseUnbilledPaidGeneration(
  env: Env,
  input: {
    key: PaidCaseKey;
    execution: PaidExecutionKey & { attemptStartedAt: number };
    generation?: number;
  }
): Promise<'released' | 'quarantined'> {
  const { execution } = input;
  if (input.generation === undefined) {
    // No canonical generation was ever granted, so this attempt opened nothing upstream.
    await clearUnbilledCase(env.BENCH_DB, {
      runId: execution.runId,
      model: execution.model,
      variant: execution.variant,
      rep: execution.rep,
      caseId: execution.caseId,
      attemptStartedAt: execution.attemptStartedAt,
    }).catch(() => {});
    return 'released';
  }
  const release = releasePaidCaseGenerationStatements(env.BENCH_DB, {
    key: input.key,
    generation: {
      runId: execution.runId,
      token: execution.token,
      generation: input.generation,
    },
  });
  const results = await env.BENCH_DB.batch(
    releaseUnbilledPaidGenerationBatch(env.BENCH_DB, {
      release,
      key: input.key,
      executor: {
        runId: execution.runId,
        token: execution.token,
        startedAt: execution.attemptStartedAt,
      },
      generation: input.generation,
    })
  );
  if ((results[0]?.meta.changes ?? 0) === 0) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_paid_generation_release_denied',
        runId: execution.runId,
        caseId: execution.caseId,
        generation: input.generation,
      })
    );
    return 'quarantined';
  }
  return 'released';
}

/**
 * Payer assignments recorded for this exact generation, split by what they prove.
 *
 * `benchmark_case_payers` is the picker's durable per-generation assignment, and its status
 * vocabulary is `eligible | detached | accepted | closed`. `owner_type` is the *account* type,
 * not a run role, so organization payers must not be filtered out.
 *
 * `detached` is the Worker's own persisted refusal — the only thing that can name a request
 * that could not pay. `eligible`/`accepted` are candidates that can still pay, so they are
 * reported separately and never used to exclude anything.
 */
async function payerAssignments(
  env: Env,
  key: PaidCaseKey,
  generation: number
): Promise<{ detached: string[]; live: string[] }> {
  const rows = await env.BENCH_DB.prepare(
    `SELECT DISTINCT payer.request_id, payer.status
    FROM benchmark_case_payers AS payer
    WHERE payer.engine_identity = ? AND payer.model = ? AND payer.variant = ?
      AND payer.rep = ? AND payer.case_id = ? AND payer.generation = ?
      AND payer.status IN ('eligible', 'accepted', 'detached')`
  )
    .bind(key.engineIdentity, key.model, key.variant, key.rep, key.caseId, generation)
    .all<{ request_id: string; status: string }>();
  return {
    detached: [
      ...new Set(rows.results.filter(r => r.status === 'detached').map(r => r.request_id)),
    ],
    live: [...new Set(rows.results.filter(r => r.status !== 'detached').map(r => r.request_id))],
  };
}

async function beginPaidCaseGeneration(
  env: Env,
  input: {
    key: PaidCaseKey;
    execution: PaidExecutionKey;
    /** A platform run's own intent; a user run passes false and relies on the membership guard. */
    platformIntent: boolean;
    purpose: BenchmarkRunPurpose;
    router: AutoRouter;
    repetitions: number;
    deliveryWindowMs: number;
    now: number;
  }
): Promise<PaidCaseStart> {
  const { execution, key } = input;
  if (input.purpose === 'user') {
    const existing = await readPaidCaseRun(env.BENCH_DB, key);
    if (existing === null || existing.status === 'cancelled') return { kind: 'cancelled' };
    if (existing.result_usable === 1) return { kind: 'reused' };
    if (existing.status === 'settled' || existing.status === 'failed') {
      throw new PaidCaseUnavailableError(
        existing.failure_reason ?? `${existing.status} without a usable result`
      );
    }
    if (
      existing.status === 'running' &&
      (existing.executor_run_id !== execution.runId || existing.executor_token !== execution.token)
    ) {
      return { kind: 'attached' };
    }
  }
  const claimStatements = claimPaidCaseStatements(env.BENCH_DB, {
    key,
    executor: { runId: execution.runId, token: execution.token },
    now: input.now,
    platform: input.platformIntent,
  });
  if (!input.platformIntent) {
    // The user executor's latch is the registry-membership form: the same transaction, the
    // exact current member row. This is what lets a platform-covered case stay covered when a
    // user's run happens to execute it, without trusting any pre-read.
    claimStatements.splice(
      claimStatements.length - 1,
      0,
      ...platformCoverageStatements(env.BENCH_DB, {
        membership: {
          router: input.router,
          engineIdentity: key.engineIdentity,
          model: key.model,
          variant: key.variant,
          repetitions: input.repetitions,
        },
        now: input.now,
      })
    );
  }
  const results = await env.BENCH_DB.batch(claimStatements);
  const inserted = results[0]?.meta.changes ?? 0;
  const transitioned = results[1]?.meta.changes ?? 0;
  const run =
    (results[claimStatements.length - 1]?.results[0] as PaidCaseRunRow | undefined) ?? null;
  if (inserted > 0 || transitioned > 0) {
    if (!run) throw new ChunkClaimLostError();
    // The claim batch writes the paid-call ledger row itself (CaseStore's
    // `claimPaidCaseStatements`). The ledger row's start is the signal: ours means this
    // invocation owns
    // the generation; an earlier start means a previous attempt is still in flight and only
    // its durable output may settle it.
    const ledgeredStartedAt = await getPaidCaseStartedAt(env.BENCH_DB, execution);
    if (ledgeredStartedAt === null) throw new ChunkClaimLostError();
    if (ledgeredStartedAt !== input.now) {
      throw new AmbiguousBenchmarkExecutionError(ledgeredStartedAt, {
        deliveryWindowMs: input.deliveryWindowMs,
      });
    }
    return {
      kind: 'started',
      generation: {
        runId: execution.runId,
        token: execution.token,
        generation: run.generation,
      },
    };
  }
  if (run === null) throw new ChunkClaimLostError();
  switch (run.status) {
    case 'cancelled':
    case 'paused':
      // `paused` is terminal for processing: a canonical slot stopped for money is not
      // re-claimed, re-deferred or graded by anyone. Only a fresh explicit reclaim (a new
      // confirmed request) can open it again, and every later snapshot of this exact
      // generation must keep returning through this branch.
      return { kind: 'cancelled' };
    case 'settled':
    case 'failed':
      if (run.result_usable === 1) return { kind: 'reused' };
      throw new PaidCaseUnavailableError(
        run.failure_reason ?? `${run.status} without a usable result`
      );
    case 'running':
      return { kind: 'attached' };
    default:
      // Still queued: the scheduler guard did not pass (lease, chunk or lane), so the
      // chunk defers and re-evaluates instead of failing the lane.
      throw new ChunkClaimLostError();
  }
}

async function processDeciderJob(
  env: Env,
  message: BenchmarkJobMessage,
  state: RunState,
  claim: SchedulerClaim,
  ctx?: SecretsExecutionContext
): Promise<void> {
  if (!message.caseIds?.length) throw new Error('Scheduler chunk has no cases');
  const caseIds = new Set(message.caseIds);
  const cases = deciderCasesForRouter(state.router, state.measurementRevision).filter(c =>
    caseIds.has(c.id)
  );
  if (cases.length !== message.caseIds.length) throw new Error('Scheduler chunk has unknown cases');

  const { benchmarkUserId, benchmarkOrgId } = state;
  if (!benchmarkUserId) {
    // startRun snapshots the effective default/override identity, so this only
    // happens if the run row was tampered with; throwing lets the queue retry.
    throw new Error(`run ${message.runId} has no benchmarkUserId`);
  }

  const rep = message.rep ?? 0;
  const chunk = message.chunk ?? 0;

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

  const instanceName = `benchmark-slot:${claim.slot}`;

  const existingCaseIds = await getExistingCaseResultIds(env.BENCH_DB, {
    runId: message.runId,
    model: message.model,
    variant: entryVariant,
    rep,
    caseIds: cases.map(c => c.id),
  });
  const casesToRun = cases.filter(c => !existingCaseIds.has(c.id));
  let graderCostUsd = 0;
  let graderFailure: DeciderGraderRetryError | null = null;

  if (casesToRun.length > 0) {
    let judge: DeciderJudge | null = null;
    if (casesToRun.some(c => c.check.kind === 'judged')) {
      try {
        judge = createDeciderJudge(await createSystemOneClient(env));
      } catch {
        throw new DeciderGraderRetryError('Decider judge client initialization failed');
      }
    }
    // Short-lived user tokens are minted at most once per audience per queue message and
    // never logged. Each goes only to routes that verify its audience: `kilo-api` reads the
    // organization catalog for a probe, and `kilo-gateway` is the CLI container's credential
    // for its gateway catalog reads. A probe's inference carries only the case capability,
    // so a probe never needs a gateway token. A CLI case warms its container before the paid
    // ledger row exists, so the CLI's one-time sqlite migration never burns the first
    // case's timeout and container capacity pressure defers the message with no ledger row
    // written. Ordinary warmup failures are non-fatal: the first case absorbs whatever
    // warmup work remains. Container capacity failures are infrastructure pressure, so the
    // queue retries the message. Warmup waits for the first case that needs a CLI call, so
    // rechecking awaited output stays in D1.
    const minted = new Map<BenchmarkTokenAudience, Promise<string>>();
    const mintedToken = (audience: BenchmarkTokenAudience) => {
      let token = minted.get(audience);
      if (token === undefined) {
        token = (async () => {
          // The bot-token mint requires an org. Only run rows written before the
          // org snapshot existed lack one; checked here so chunks whose cases are
          // all recorded still finish without a mint.
          if (!benchmarkOrgId) throw new Error(`run ${message.runId} has no benchmarkOrgId`);
          return fetchBenchmarkUserToken(
            env,
            benchmarkUserId,
            benchmarkOrgId,
            audience,
            fetch,
            ctx
          );
        })();
        minted.set(audience, token);
      }
      return token;
    };
    let catalogForProbes: Promise<z.infer<typeof BenchmarkModelCatalogSchema>> | undefined;
    const probeCatalogEntry = async (model: string): Promise<CatalogModel> => {
      catalogForProbes ??= mintedToken(KILO_API_AUDIENCE).then(token => {
        if (!benchmarkOrgId) throw new Error(`run ${message.runId} has no benchmarkOrgId`);
        return fetchExecutableBenchmarkModelCatalog(
          env,
          { benchmarkUserId, benchmarkOrgId },
          fetch,
          token,
          ctx
        );
      });
      // A catalog read that fails after the paid case started is a transient lookup failure,
      // not a missing template: the case is cleared and the chunk retried, never failed.
      const catalog = await catalogForProbes.catch(error => {
        throw new BenchmarkCatalogLoadError(
          `Benchmark model catalog could not be loaded: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'catalog_load'
        );
      });
      const entry = catalog.data.find(candidate => candidate.id === model);
      if (!entry) {
        throw new BenchmarkProbeFamilyError(
          `Probe lane cannot run: ${model} is not in the executable model catalog.`,
          `${model}/missing`
        );
      }
      return entry;
    };
    let warmedUp = false;
    const warmUpContainer = async (gatewayToken: string) => {
      if (warmedUp) return;
      await warmUpCliContainer(env, {
        instanceName,
        model: message.model,
        kiloToken: gatewayToken,
        kiloApiUrl: env.KILO_CLI_API_URL,
        orgId: benchmarkOrgId,
      }).catch(error => {
        if (isRetryableContainerAvailabilityError(error)) throw error;
      });
      warmedUp = true;
    };

    // Concurrency 1: the CLI's sqlite state in the container is not safe under
    // concurrent sessions (partial-migration crashes); the container serializes
    // too, so higher concurrency here would only hold HTTP requests open.
    // The platform pool decides coverage at admission: a member pair's case run is
    // covered by Kilo even inside a user-paid executor (the sync also latches a
    // membership that commits later, so the other order is covered too).
    // A platform run is the platform's own work: it covers every case it executes. Only a
    // user-paid executor has to ask, and a read fault there fails closed (nobody is charged
    // as a platform-covered case by accident).
    // Coverage is decided only inside the claim batch, never from this read:
    // - a platform run IS the platform's own intent, so it latches its own case;
    // - a user run passes no intent, and the claim's atomic membership guard evaluates the
    //   exact (router, engine identity, model, variant, repetitions) row in the same
    //   transaction. True membership latches Kilo even for a user executor; a pair removed
    //   before the latch never covers, so a Kilo-only approval is never silently billed to a
    //   user either.
    const platformIntent = state.purpose === 'platform';
    await runCasesWithConcurrency(casesToRun, 1, async benchCase => {
      const pendingKey = {
        run_id: message.runId,
        model: message.model,
        variant: storedVariant,
        case_id: benchCase.id,
        rep,
      };
      const execution = {
        runId: message.runId,
        model: message.model,
        variant: storedVariant,
        rep,
        caseId: benchCase.id,
        token: claim.token,
      };
      const caseKey: PaidCaseKey = {
        engineIdentity: state.engineIdentity,
        model: message.model,
        variant: storedVariant,
        rep,
        caseId: benchCase.id,
      };
      let attemptStartedAt: number | undefined;
      // Spend recorded by this attempt's own result, so a later failure never clears a
      // generation as "unbilled" when the provider was actually paid.
      let billedUsd = 0;
      let canonicalGeneration: number | undefined;
      let unstartedRetryAt: number | undefined;
      let paidStart: 'reused' | 'cancelled' | null = null;
      const runPaidCase = async (): Promise<StoredDeciderOutput | null> => {
        const promptRevision = state.measurementRevision;
        // A container that loses its caller still posts its result, so an ambiguity there
        // waits out that delivery. A probe answers in this invocation and has no later
        // delivery to wait for, so its ambiguity fails the lane at once.
        const deliveryWindowMs = isProbeCase(benchCase) ? 0 : PAID_OUTPUT_WAIT_MS;
        const priorStartedAt = await getPaidCaseStartedAt(env.BENCH_DB, execution);
        if (priorStartedAt !== null) {
          throw new AmbiguousBenchmarkExecutionError(priorStartedAt, { deliveryWindowMs });
        }
        // Mint before the paid start, so a mint failure never follows it. A probe needs only
        // the `kilo-api` token for its catalog read; a CLI case's container needs the
        // `kilo-gateway` token.
        const launch = isProbeCase(benchCase)
          ? { kind: 'probe' as const, benchCase, catalogToken: null }
          : {
              kind: 'cli' as const,
              benchCase,
              catalogToken: await mintedToken(KILO_GATEWAY_AUDIENCE),
            };
        if (launch.kind === 'probe') await mintedToken(KILO_API_AUDIENCE);
        else await warmUpContainer(launch.catalogToken);
        let startedAt = Date.now();
        const start = await beginPaidCaseGeneration(env, {
          key: caseKey,
          execution,
          platformIntent,
          purpose: state.purpose,
          router: state.router,
          repetitions: state.repetitions,
          deliveryWindowMs,
          now: startedAt,
        });
        if (start.kind === 'attached') {
          throw new PaidCaseAttachedError('A funded generation owns this case run; waiting.');
        }
        if (start.kind !== 'started') {
          // No inference this pass: the case run is settled (adopt its result) or
          // cancelled (nothing is owed). The caller decides from here.
          paidStart = start.kind;
          return null;
        }
        attemptStartedAt = startedAt;
        const generation = start.generation.generation;
        canonicalGeneration = generation;
        let retried = false;
        let priorCostUsd: number | null = null;
        let priorUsage: Omit<AttemptUsage, 'costUsd'> | null = null;
        console.log(
          JSON.stringify({
            event: 'benchmark_case_execution_started',
            runId: message.runId,
            model: message.model,
            variant: storedVariant,
            rep,
            caseId: benchCase.id,
            slot: claim.slot,
            chunk,
            promptRevision,
            outputDeadline: startedAt + deliveryWindowMs,
          })
        );
        // The case-scoped capability is issued from the canonical generation this batch
        // just claimed and re-issued for a retry (its `startedAt` moves). Every provider
        // request carries it, so the gateway attributes the call to exactly one paid
        // generation; the platform bot token stays on the exact catalog reads only.
        let inference = await caseInferenceProxy(
          env,
          {
            engineIdentity: state.engineIdentity,
            runId: message.runId,
            model: message.model,
            variant: storedVariant,
            caseId: benchCase.id,
            rep,
            generation,
            startedAt,
            catalogToken: launch.catalogToken,
            kiloApiUrl: env.KILO_CLI_API_URL,
          },
          ctx
        );
        // A probe goes straight to the gateway with the captured request template; every
        // other case keeps the CLI container, which owns the workspace and tool execution.
        // Both transports re-check the canonical live generation before they spend
        // anything (RunnerCancel's fence) and refuse a start that is not live.
        const invokeCase =
          launch.kind === 'probe'
            ? async () =>
                runCancellableProbeCase(env, {
                  instanceName,
                  execution: {
                    ...execution,
                    attemptStartedAt: startedAt,
                    retried,
                    priorCostUsd,
                    priorUsage,
                    canonicalGeneration,
                    engineIdentity: state.engineIdentity,
                  },
                  model: message.model,
                  variant: cliVariant,
                  benchCase: launch.benchCase,
                  catalogModel: await probeCatalogEntry(message.model),
                  kiloApiUrl: env.KILO_CLI_API_URL,
                  orgId: benchmarkOrgId,
                  inference,
                }).catch((error: unknown) => {
                  // Terminal, known outcomes keep their own type so the outer handler can act
                  // on them: a pause (`BenchmarkCaseCancelledError`) must not be re-labelled as
                  // an uncertain paid attempt, and a pre-spawn refusal must not either.
                  if (
                    error instanceof BenchmarkProbeFamilyError ||
                    error instanceof BenchmarkCaseNotStartedError ||
                    error instanceof BenchmarkCaseCancelledError
                  )
                    throw error;
                  throw new AmbiguousBenchmarkExecutionError(startedAt, {
                    cause: error,
                    deliveryWindowMs,
                  });
                })
            : async () =>
                runDeciderCaseViaCli(env, {
                  instanceName,
                  model: message.model,
                  benchCase: launch.benchCase,
                  kiloToken: launch.catalogToken,
                  kiloApiUrl: env.KILO_CLI_API_URL,
                  orgId: benchmarkOrgId,
                  variant: cliVariant,
                  inferenceProxy: inference,
                  resultCallback: {
                    url: env.BENCH_RESULT_URL,
                    execution: {
                      ...execution,
                      attemptStartedAt: startedAt,
                      retried,
                      priorCostUsd,
                      priorUsage,
                      canonicalGeneration,
                      engineIdentity: state.engineIdentity,
                    },
                  },
                }).catch((error: unknown) => {
                  if (
                    isRetryableContainerAvailabilityError(error) ||
                    error instanceof BenchmarkCaseNotStartedError ||
                    error instanceof BenchmarkCaseCancelledError
                  )
                    throw error;
                  throw new AmbiguousBenchmarkExecutionError(startedAt, { cause: error });
                });
        const first = await invokeCase();
        // A trusted Worker stop is authoritative and independent of prior calls, cost and
        // output: it is handled before the empty-output retry and before the user
        // killed-before-events ambiguity, so a new case is never invoked on it. A stop that
        // arrived after this attempt already billed (`costUsd > 0`) is not "unspent", so it
        // is surfaced as the same typed terminal stop and never cleared as unbilled.
        if (first.stop !== undefined) {
          return { result: first, retried: false, attemptStartedAt: startedAt, promptRevision };
        }
        if (isProbeCase(benchCase)) {
          return { result: first, retried: false, attemptStartedAt: startedAt, promptRevision };
        }
        // The CLI occasionally ends a session with no assistant text at all
        // (transient empty completion: a lone step_finish with cost 0), or dies from
        // a signal before its first event. Mirror the production classifier's policy
        // and retry once.
        const emptyCompletion = first.exitCode === 0 && first.text.length === 0;
        if (
          isExactModelUnavailableResult(first, message.model) ||
          isCatalogLoadFailureResult(first) ||
          isUnsupportedModelResult(first, message.model) ||
          !(emptyCompletion || isKilledBeforeEventsResult(first)) ||
          hasThrottleDiagnostic(first)
        ) {
          return { result: first, retried: false, attemptStartedAt: startedAt, promptRevision };
        }
        // A user-owned generation is never replayed by this invocation: a second paid call
        // would be a second generation nobody explicitly asked for. An empty answer is
        // graded as-is. A child that spawned and produced no event is NOT proof that no
        // gateway request was admitted — only an affirmative pre-spawn `not_started`
        // refusal is — so the generation keeps its ledger and the case is treated as an
        // uncertain in-flight attempt: wait out the delivery window, then recover or
        // quarantine. Nothing else is spent under the user's request.
        if (state.purpose === 'user') {
          if (isKilledBeforeEventsResult(first)) {
            throw new AmbiguousBenchmarkExecutionError(startedAt, { deliveryWindowMs });
          }
          return { result: first, retried: false, attemptStartedAt: startedAt, promptRevision };
        }
        startedAt = Math.max(Date.now(), startedAt + 1);
        // The retry's start must move in the ledger and on the canonical fence in the same
        // transaction: RunnerCancel's live check compares `benchmark_case_runs.started_at`
        // to ISO(attemptStartedAt), so a ledger-only move would refuse every retry.
        const restarted = await env.BENCH_DB.batch([
          restartPaidCaseStatement(env.BENCH_DB, { ...execution, attemptStartedAt }, startedAt),
          restartPaidCaseRunStatement(env.BENCH_DB, {
            key: caseKey,
            executor: { runId: execution.runId, token: execution.token },
            startedAt,
          }),
        ]);
        if ((restarted[0]?.meta.changes ?? 0) === 0) {
          return { result: first, retried: false, promptRevision };
        }
        // The retry is a further paid call of the same generation: its capability must name
        // the new signed start or the gateway rejects it as expired.
        inference = await caseInferenceProxy(
          env,
          {
            engineIdentity: state.engineIdentity,
            runId: message.runId,
            model: message.model,
            variant: storedVariant,
            caseId: benchCase.id,
            rep,
            generation,
            startedAt,
            catalogToken: launch.catalogToken,
            kiloApiUrl: env.KILO_CLI_API_URL,
          },
          ctx
        );
        attemptStartedAt = startedAt;
        retried = true;
        priorCostUsd = first.costUsd;
        priorUsage = {
          inputTokens: first.inputTokens,
          cachedInputTokens: first.cachedInputTokens,
          outputTokens: first.outputTokens,
          reasoningTokens: first.reasoningTokens,
        };
        await deletePendingDeciderOutput(env.BENCH_DB, pendingKey);
        console.log(
          JSON.stringify({
            event: 'benchmark_case_execution_retry_started',
            runId: message.runId,
            model: message.model,
            variant: storedVariant,
            rep,
            caseId: benchCase.id,
            slot: claim.slot,
            chunk,
            attemptStartedAt: startedAt,
            outputDeadline: startedAt + PAID_OUTPUT_WAIT_MS,
          })
        );
        // A first attempt killed before any event says nothing about the model, so it is
        // cleared and deferred with its unreached retry; an empty answer is graded instead.
        // The retry is a further paid call, so only an affirmative pre-spawn refusal lets it
        // be skipped: a spawned child that emitted nothing may still have admitted a gateway
        // request.
        let retryNotReached: unknown = null;
        const retry = await invokeCase().catch((error: unknown) => {
          // Only a refusal that proves nothing was spent may skip the retry. A container
          // capacity error on the *retry* is that proof (`BenchmarkCaseNotStartedError`
          // from the launch fence); anything else — including a spawned child with no
          // events — keeps the ambiguity and stops instead of paying again.
          if (
            isRetryableContainerAvailabilityError(error) ||
            error instanceof BenchmarkCaseNotStartedError
          ) {
            retryNotReached = error;
            return null;
          }
          // A cancel is a known terminal stop of this generation, not a failed retry.
          throw error;
        });
        if (retry === null) {
          console.warn(
            JSON.stringify({
              event: 'benchmark_case_execution_retry_not_started',
              runId: message.runId,
              model: message.model,
              variant: storedVariant,
              rep,
              caseId: benchCase.id,
              slot: claim.slot,
              chunk,
              attemptStartedAt: startedAt,
            })
          );
          unstartedRetryAt = startedAt;
          // The first attempt was killed before any event and the retry never reached the
          // provider, so there is no measurement to grade: returning `first` would record a
          // zero for a case that never ran (and count it against the model). Hand the exact
          // not-reached signal to the chunk, which defers it through normal admission.
          if (isKilledBeforeEventsResult(first)) {
            // Same atomic release: a spawned-then-killed child may still have admitted a
            // request, so only CaseStore's native-proof guard may reopen the slot, and the
            // ledger clears with it in one transaction.
            const cleared = await releaseUnbilledPaidGeneration(env, {
              key: caseKey,
              execution: { ...execution, attemptStartedAt: startedAt },
              generation: canonicalGeneration,
            }).catch(() => 'quarantined' as const);
            if (cleared === 'quarantined') return null;
            if (retryNotReached !== null) throw retryNotReached;
            throw new ChunkClaimLostError();
          }
          return { result: first, retried: false, attemptStartedAt: startedAt, promptRevision };
        }
        addPriorAttempt(retry, first);
        return { result: retry, retried: true, attemptStartedAt: startedAt, promptRevision };
      };
      const adoptCaseForRun = () =>
        adoptReusableCaseResult(env.BENCH_DB, {
          runId: message.runId,
          router: state.router,
          engineIdentity: state.engineIdentity,
          model: message.model,
          variant: storedVariant,
          rep,
          caseId: benchCase.id,
          minimumRevision: state.measurementRevision,
        });
      let output: StoredDeciderOutput | null = null;
      try {
        const pending = await getPendingDeciderOutput(env.BENCH_DB, pendingKey).catch(() => {
          throw new DeciderGraderRetryError('Pending decider output could not be read');
        });
        output = pending;
        if (!output) {
          // Last check before money: a peer run may have measured this slot after this
          // chunk was materialized, or left a durable pending output. Adopt it instead of
          // paying for the same case twice.
          const adopted = await adoptCaseForRun();
          if (adopted === 'graded') return;
          if (adopted === 'pending') {
            output = await getPendingDeciderOutput(env.BENCH_DB, pendingKey);
          }
        }
        if (!output) {
          output = await runPaidCase();
          if (output === null) {
            if (paidStart === 'cancelled') return;
            // The fence did not grant inference: the case run already settled under a
            // valid result this run does not hold yet. Adopt it; never infer a second one.
            const adopted = await adoptCaseForRun();
            if (adopted === 'graded') return;
            if (adopted === 'pending') {
              output = await getPendingDeciderOutput(env.BENCH_DB, pendingKey);
            }
            if (!output) {
              throw new PaidCaseAttachedError(
                'A settled case run result is not readable yet; waiting for it.'
              );
            }
          }
        }
        const { result } = output;
        attemptStartedAt = output.attemptStartedAt;
        billedUsd = result.costUsd ?? 0;
        // A refused payer left nothing upstream: no row, no charge, no retry, and the
        // model keeps its record clean. The controller pauses the request on this signal.
        const unfunded = caseInferenceRefusal(result);
        if (unfunded !== null) throw new PaidCaseUnfundedError(unfunded);
        const throttled = isUnbilledTransientProviderResult(result);
        const unsupported = isUnsupportedModelResult(result, message.model);
        // The billing route itself was unavailable: unbilled infrastructure, retried through
        // normal admission — never graded as a zero and never a funding pause.
        if (caseInferenceUnavailable(result)) {
          // Billing/gateway infrastructure was unreachable before any provider call. Not a
          // funding verdict and not a model outcome: never graded, never paused. Released as
          // unbilled only when this attempt recorded no spend; otherwise the ledger stands.
          if (billedUsd > 0) {
            // Already billed: keep the ledger and end the case without a grade. Nothing is
            // retried for it, so no new spend is opened on this slot.
            console.warn(
              JSON.stringify({
                event: 'benchmark_case_infra_stop_after_usage',
                runId: message.runId,
                caseId: benchCase.id,
              })
            );
            return;
          }
          if (attemptStartedAt !== undefined) {
            const outcome = await releaseUnbilledPaidGeneration(env, {
              key: caseKey,
              execution: { ...execution, attemptStartedAt },
              generation: canonicalGeneration,
            });
            if (outcome === 'quarantined') return;
          }
          throw new BenchmarkInfraUnavailableError('Case inference infrastructure is unavailable.');
        }
        if (result.stop?.reason === 'not_live') {
          // The generation is gone (paused elsewhere, closed, superseded). Not a measurement,
          // not a funding verdict, and not something to retry or pause: the ledger stays and
          // nothing is graded, so no readiness or failure streak can come from it.
          console.log(
            JSON.stringify({
              event: 'benchmark_case_not_live',
              runId: message.runId,
              caseId: benchCase.id,
              generation: canonicalGeneration ?? null,
            })
          );
          return;
        }
        if (result.stop?.reason === 'model_permanently_failed') {
          // The exact model is already permanently failed. No grade, no pause, no charge and
          // no new permanent-failure vote: the lane ends without recording another attempt.
          throw new BenchmarkModelUnavailableError(PROFILE_MODEL_UNAVAILABLE_FAILURE_REASON);
        }
        if (isCatalogLoadFailureResult(result) || unsupported || throttled) {
          // A known-unbilled failure produced no charge: the exact generation goes back to
          // the queue for another attempt with its payers intact — but only if CaseStore's
          // native-proof guard lets it. A refused release keeps the ledger row and quits the
          // case rather than re-running work that may have been admitted.
          const { token: _token, ...unbilled } = execution;
          if (attemptStartedAt !== undefined) {
            const outcome = await releaseUnbilledPaidGeneration(env, {
              key: caseKey,
              execution: { ...execution, attemptStartedAt },
              generation: canonicalGeneration,
            });
            if (outcome === 'quarantined') return;
          }
          if (pending && (await getPaidCaseStartedAt(env.BENCH_DB, unbilled)) === null) {
            await deletePendingDeciderOutput(env.BENCH_DB, pendingKey);
          }
          if (throttled) {
            throw new BenchmarkThrottleError(
              'Provider throttled or failed an unbilled benchmark request'
            );
          }
          throw new BenchmarkCatalogLoadError(
            unsupported
              ? 'Gateway rejected the exact model for an unbilled call.'
              : 'Benchmark model catalog could not be loaded.',
            unsupported ? 'model_resolution' : 'catalog_load'
          );
        }
        if (!pending) {
          await savePendingDeciderOutput(env.BENCH_DB, pendingKey, output).catch(async () => {
            // No callback can satisfy a retry that never reached its container, so its
            // ledger generation must not outlive the only copy of the first output.
            if (unstartedRetryAt !== undefined) {
              const retryAt = unstartedRetryAt;
              await clearUnbilledCase(env.BENCH_DB, {
                ...execution,
                attemptStartedAt: retryAt,
              }).catch((error: unknown) => {
                console.warn(
                  JSON.stringify({
                    event: 'benchmark_unstarted_retry_clear_failed',
                    runId: message.runId,
                    model: message.model,
                    variant: storedVariant,
                    rep,
                    caseId: benchCase.id,
                    slot: claim.slot,
                    chunk,
                    attemptStartedAt: retryAt,
                    errorCategory: benchmarkErrorCategory(error),
                  })
                );
              });
            }
            throw new DeciderGraderRetryError('Pending decider output could not be saved');
          });
        }
        if (isExactModelUnavailableResult(result, message.model)) {
          throw new BenchmarkModelUnavailableError(PROFILE_MODEL_UNAVAILABLE_FAILURE_REASON);
        }
        graderCostUsd += await recordDeciderOutput(
          env,
          {
            runId: message.runId,
            model: message.model,
            variant: storedVariant,
            rep,
            caseId: benchCase.id,
          },
          benchCase,
          output,
          judge,
          state.engineIdentity
        );
      } catch (error) {
        if (error instanceof BenchmarkCaseCancelledError) {
          // A payer pause (or an admin cancel of the platform run) stopped this generation.
          // The container reports its own outcome without this invocation deciding it: a
          // case that already produced output delivers it as completed, and the queued
          // recovery pass grades that output under the cancelled generation (billing is per
          // model request, so nothing is charged or refunded here). A case stopped after its
          // child spawned delivers `cancelled` without a response — attribution is kept,
          // because a native receipt may exist — and only an affirmative pre-spawn
          // `not_started` clears the ledger row. This invocation never clears it, so the
          // late callback can still correlate. No lane failure and no model-failure count.
          await queueOutputRecovery(env, {
            runId: message.runId,
            model: message.model,
            variant: storedVariant,
            rep,
            caseId: benchCase.id,
          }).catch((recoveryError: unknown) => {
            console.warn(
              JSON.stringify({
                event: 'benchmark_cancelled_case_recovery_failed',
                runId: message.runId,
                caseId: benchCase.id,
                errorCategory: benchmarkErrorCategory(recoveryError),
              })
            );
          });
          console.log(
            JSON.stringify({
              event: 'benchmark_case_cancelled',
              runId: message.runId,
              model: message.model,
              variant: storedVariant,
              rep,
              caseId: benchCase.id,
              slot: claim.slot,
              chunk,
            })
          );
          return;
        }
        if (error instanceof PaidCaseUnfundedError) {
          // A refused payer pauses THIS case, never the run: no run row, other chunks, other
          // pairs and funded siblings are untouched, and no profile failure or lane failure is
          // recorded (a refusal is neither a model outcome nor infrastructure).
          //
          // The canonical slot is paused by the store under an exact-generation guard. If the
          // guard refuses, the generation was not ours any more, so the claim is not graded
          // and the case is not quietly completed as if measured.
          const transitionId = `unfunded:${message.runId}:${benchCase.id}:${attemptStartedAt ?? 0}`;
          // A funder is named only when the store's own record proves one: exactly one
          // detached payer. Several detached requests is the "all candidates refused" case,
          // and then no exclusion is passed — every live plan may still pay, so the canonical
          // guard decides on its own evidence and the slot is paused only if none remains.
          const assignments =
            canonicalGeneration === undefined
              ? { detached: [] as string[], live: [] as string[] }
              : await payerAssignments(env, caseKey, canonicalGeneration).catch(() => ({
                  detached: [] as string[],
                  live: [] as string[],
                }));
          // A funder is named only when it is the single durably-detached request AND no
          // candidate can still pay. Naming a live request would exclude it from the
          // canonical eligibility check and pause a slot a late funded entrant owns; naming
          // nothing when several are detached is what lets the store pause the slot for all
          // of them, which is the outcome a fully refused generation must have.
          const funderRequestId =
            assignments.live.length === 0 && assignments.detached.length === 1
              ? assignments.detached[0]
              : null;
          const stopped = await (async () => {
            if (canonicalGeneration === undefined) return null;
            const results = await env.BENCH_DB.batch(
              pausePaidUnfundedCaseStatements(env.BENCH_DB, {
                key: caseKey,
                generation: {
                  runId: execution.runId,
                  token: execution.token,
                  generation: canonicalGeneration,
                },
                reason: 'no_funds',
                ...(funderRequestId === null ? {} : { funderRequestId }),
                transitionId,
              })
            );
            return paidUnfundedStopOutcome(results);
          })().catch((pauseError: unknown) => {
            console.warn(
              JSON.stringify({
                event: 'benchmark_paid_unfunded_pause_failed',
                runId: message.runId,
                caseId: benchCase.id,
                errorCategory: benchmarkErrorCategory(pauseError),
              })
            );
            return null;
          });
          // The request-side reconcile is the fallback for a stop that arrived before any
          // generation existed; the store statement already handles the normal path.
          if (stopped === null && funderRequestId !== null) {
            await pauseUnfundedPaidRequests(env, {
              refusedCases: [
                {
                  engineIdentity: state.engineIdentity,
                  model: message.model,
                  variant: storedVariant,
                  rep,
                  caseId: benchCase.id,
                  funderRequestId,
                },
              ],
              reason: error.code,
            }).catch(() => {});
          }
          console.log(
            JSON.stringify({
              event: 'benchmark_paid_case_unfunded',
              runId: message.runId,
              model: message.model,
              variant: storedVariant,
              rep,
              caseId: benchCase.id,
              code: error.code,
              paused: stopped?.paused ?? [],
              kept: stopped?.kept ?? [],
              caseRun: stopped?.caseRun ?? 'not_running',
            })
          );
          return;
        }
        if (error instanceof PaidCaseAttachedError || error instanceof PaidCaseUnavailableError) {
          // Both decisions belong to the chunk: attached defers and re-reads the fence,
          // unavailable ends the lane with the failure its admission recorded. Neither is
          // ever replayed as a paid attempt.
          throw error;
        }
        if (error instanceof DeciderGraderRetryError) {
          graderFailure = error;
          return;
        }
        if (
          (isRetryableContainerAvailabilityError(error) ||
            error instanceof BenchmarkProbeFamilyError ||
            error instanceof BenchmarkCatalogLoadError ||
            error instanceof BenchmarkCaseNotStartedError) &&
          attemptStartedAt !== undefined &&
          billedUsd === 0
        ) {
          await releaseUnbilledPaidGeneration(env, {
            key: caseKey,
            execution: { ...execution, attemptStartedAt },
            generation: canonicalGeneration,
          }).catch(() => 'quarantined' as const);
        }
        throw error;
      }
    });
  }
  console.log(
    JSON.stringify({
      event: 'benchmark_decider_grader_cost',
      runId: message.runId,
      model: message.model,
      variant: storedVariant,
      rep,
      chunk,
      graderCostUsd,
    })
  );
  if (graderFailure) throw graderFailure;

  return;
}

function failedRow(
  message: BenchmarkJobMessage,
  caseId: string,
  routeKey: string | null,
  startedAt: number,
  error: unknown,
  rep: number,
  promptRevision: number
): CaseResultRow {
  return {
    run_id: message.runId,
    model: message.model,
    variant: variantToStorage(message.variant),
    case_id: caseId,
    route_key: routeKey,
    score: 0,
    latency_ms: Math.round(performance.now() - startedAt),
    cost_usd: error instanceof ClassifierRunError ? error.cost : null,
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    error: JSON.stringify(formatError(error)).slice(0, 500),
    fallback_reason: null,
    // A failed classification missed its route; decider rows carry no route hit.
    route_hit: message.kind === 'classifier' ? false : null,
    retried: null,
    exit_code: null,
    output_prefix: null,
    event_count: null,
    last_event_types: null,
    tool_calls: null,
    tool_names: null,
    step_count: null,
    final_finish_reason: null,
    rep,
    timed_out: 0,
    prompt_revision: promptRevision,
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

/** Failure reason written to profile entries whose lane never finished; the class names the cause. */
export const PROFILE_LANE_DEAD_FAILURE_REASON = 'Benchmark lane did not finish.';

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
): Promise<{
  unfinished: Lane[];
  deadLaneKeys: Set<string>;
  laneFailures: RunLaneFailureRow[];
  /** True when a cancelled case run removed a slot from this run's expectation. */
  hasCancelledSlots: boolean;
}> {
  const [laneCounts, laneFailures, expectations, cancelled, marker] = await Promise.all([
    countCaseResultsByLane(db, runId),
    listLaneFailures(db, runId),
    laneCaseExpectations(db, runId),
    laneCancelledCaseCounts(db, runId),
    db.prepare('SELECT 1 AS ok FROM scheduler_runs WHERE run_id = ?').bind(runId).first(),
  ]);
  const initialized = marker !== null;
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
  let hasCancelledSlots = false;
  const unfinished = lanes.filter(lane => {
    const key = laneKey(lane.model, lane.variant, lane.rep);
    // A lane that materialized chunks is complete at the slots those chunks hold: a
    // paid run measures only the slots it admitted, and a narrowed run must not wait
    // on cases it never scheduled. A slot whose case run was cancelled is not owed.
    // Lanes without chunks keep the catalog count.
    const skipped = cancelled.get(key) ?? 0;
    if (skipped > 0) hasCancelledSlots = true;
    // A scheduler-initialized run measures exactly what its chunks hold. A lane with no
    // chunk was either narrowed away (a paid request after reuse) or fully reused, so it
    // owes nothing — that is how a zero-inference paid run still settles and readies its
    // pairs. Whole-run legacy work has no marker and keeps the catalog count.
    const expected = Math.max(
      0,
      (expectations.has(key) ? (expectations.get(key) as number) : initialized ? 0 : caseCount) -
        skipped
    );
    return (countByLane.get(key) ?? 0) < expected;
  });
  return {
    unfinished,
    deadLaneKeys: new Set(laneFailures.map(f => laneKey(f.model, f.variant, f.rep))),
    laneFailures,
    hasCancelledSlots,
  };
}

/**
 * Profile failures a settled decider run records: an entry with a dead lane fails with the
 * most severe cause its lanes recorded, and an entry whose cases nearly all hit one
 * provider rejection is `unsupported` instead of ready at zero accuracy.
 */
function settledEntryFailures(
  entries: readonly { model: string; variant: string }[],
  deadLanes: readonly Lane[],
  laneFailures: readonly RunLaneFailureRow[],
  rows: readonly CaseResultRow[]
): Array<{ entry: { model: string; variant: string }; failure: ProfileFailure }> {
  const entryKey = (model: string, variant: string) => JSON.stringify([model, variant]);
  const deadEntryKeys = new Set(deadLanes.map(lane => entryKey(lane.model, lane.variant)));
  const laneClasses = new Map<string, BenchmarkProfileFailureClass[]>();
  for (const failure of laneFailures) {
    const key = entryKey(failure.model, failure.variant);
    laneClasses.set(key, [
      ...(laneClasses.get(key) ?? []),
      parseFailureClass(failure.failure_class),
    ]);
  }
  const rowsByEntry = new Map<string, CaseResultRow[]>();
  for (const row of rows) {
    const key = entryKey(row.model, row.variant);
    const entryRows = rowsByEntry.get(key);
    if (entryRows) entryRows.push(row);
    else rowsByEntry.set(key, [row]);
  }
  return entries.flatMap(entry => {
    const key = entryKey(entry.model, entry.variant);
    if (deadEntryKeys.has(key)) {
      const failureClass = mostSevereFailureClass(laneClasses.get(key) ?? []);
      return [{ entry, failure: { failureClass, reason: PROFILE_LANE_DEAD_FAILURE_REASON } }];
    }
    const failure = unsupportedRejection(rowsByEntry.get(key) ?? []);
    return failure ? [{ entry, failure }] : [];
  });
}

async function finalizeRunIfComplete(
  env: Env,
  runId: string,
  kind: BenchmarkKind,
  // Run snapshot already loaded by the caller (startRun / processJob / processDeadLetter).
  state: RunState
): Promise<void> {
  const enqueuedModels = state.models.filter(m => m.enqueued);
  const caseCount = expectedCaseCount(kind, state.router, state.measurementRevision);

  // The run finalizes once every lane is accounted for, so one dead lane no
  // longer wedges the run until the stale sweep.
  const {
    unfinished: deadLanes,
    deadLaneKeys,
    laneFailures,
    hasCancelledSlots,
  } = await loadLaneAccounting(env.BENCH_DB, runId, state, caseCount);
  if (deadLanes.some(lane => !deadLaneKeys.has(laneKey(lane.model, lane.variant, lane.rep)))) {
    return;
  }

  // A classifier run derives one winner from a single comparable set, and its
  // models are not registry-tracked, so a dead lane fails the whole run. Decider
  // runs settle per entry below — one dead model never discards the rest.
  if (deadLanes.length > 0 && kind === 'classifier') {
    const [first, ...rest] = deadLanes;
    await failRunAndDrain(env, runId, {
      failureClass: 'unknown',
      reason:
        `lane dead-lettered: ${first.model} variant ${variantFromStorage(first.variant) ?? 'default'} rep ${first.rep}` +
        (rest.length > 0 ? ` (+${rest.length} more)` : ''),
    });
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

  // Every decider run feeds the one global registry — the platform routing table
  // and every owner's custom table are assembled from it, so no decider run
  // publishes an artifact of its own.
  if (kind === 'decider') {
    // A paid run settles only the registry rows it claimed, and only when every slot it
    // materialized produced a result. A paused, cancelled or partially funded request
    // leaves the pair measured-but-incomplete: the row returns to the queue instead of
    // publishing a ranking with a gap, and the platform table is untouched.
    if (state.purpose === 'user') {
      // Per pair, not per run: a pair whose every materialized slot produced a result is
      // ready even when another model in the same request died or was paused. Only the pairs
      // that are short get their claims released, so the finished one is never unreadied and
      // an unrelated failure cannot withhold a valid measurement.
      const releasedPairs: { model: string; variant: string | null }[] = [];
      const completePairs: { model: string; variant: string | null }[] = [];
      const deadPairKeys = new Set(
        deadLanes.map(lane => exactPairKey(lane.model, variantFromStorage(lane.variant)))
      );
      for (const model of enqueuedModels) {
        const entry = { model: model.model, variant: variantFromStorage(model.variant) };
        const key = exactPairKey(entry.model, entry.variant);
        const cancelledSlots = await env.BENCH_DB.prepare(
          `SELECT 1 FROM benchmark_runs AS run
          CROSS JOIN scheduler_chunks AS chunk
          CROSS JOIN json_each(chunk.case_ids) AS planned
          JOIN benchmark_case_runs AS case_run
            ON case_run.engine_identity = run.engine_identity
            AND case_run.model = chunk.model AND case_run.variant = chunk.variant
            AND case_run.rep = chunk.rep AND case_run.case_id = planned.value
          WHERE chunk.run_id = ? AND run.id = chunk.run_id AND chunk.model = ?
            AND chunk.variant = ? AND case_run.status IN ('cancelled', 'paused')
            AND case_run.result_usable = 0 LIMIT 1`
        )
          .bind(runId, entry.model, variantToStorage(entry.variant))
          .first();
        const measuredCases = rows.filter(
          row => row.model === entry.model && row.variant === variantToStorage(entry.variant)
        ).length;
        const expected =
          state.repetitions * expectedCaseCount(kind, state.router, state.measurementRevision);
        const done = !deadPairKeys.has(key) && cancelledSlots === null && measuredCases >= expected;
        if (done) completePairs.push(entry);
        else releasedPairs.push(entry);
      }
      // Record the attempt so a fresh valid measurement (a zero score included) counts as
      // progress. A pair whose lane actually died behind six proven zero-progress runs is a
      // model failure on a user-paid run too; a run stopped by a pause, a no-funds hold or
      // an operator fence is `cancelled`, so it neither extends nor breaks the streak, and
      // a partial run that never attempted its expected cases stays out of the history.
      const paidFailures = new Map<string, ProfileFailure>();
      for (const { entry, failure } of settledEntryFailures(
        enqueuedModels.map(m => ({ model: m.model, variant: m.variant })),
        deadLanes,
        laneFailures,
        rows
      )) {
        paidFailures.set(exactPairKey(entry.model, entry.variant), failure);
      }
      await settleProfileRunAttempts(env.BENCH_DB, {
        runId,
        router: state.router,
        engineIdentity: state.engineIdentity,
        repetitions: state.repetitions,
        rows,
        attempts: enqueuedModels.map(m => {
          const entry = { model: m.model, variant: variantFromStorage(m.variant) };
          const failure = paidFailures.get(exactPairKey(m.model, m.variant)) ?? null;
          const pairComplete = completePairs.some(
            done => done.model === entry.model && done.variant === entry.variant
          );
          return {
            entry,
            enqueued: m.enqueued,
            failure,
            // Per pair, never per run: a pair whose every materialized slot produced a
            // result is a real attempt and resets its own streak, even when a sibling pair
            // in the same request was paused or died. Only an incomplete pair is
            // `cancelled`, which neither extends nor breaks the streak.
            cancelled: !pairComplete && failure === null,
            fenced: false,
          };
        }),
      }).catch(error => {
        console.warn(
          JSON.stringify({
            event: 'benchmark_paid_profile_attempt_error',
            runId,
            ...formatError(error),
          })
        );
      });
      // The readiness fence: while an alias promotion holds the readiness lease, a ready
      // publication must not land. `markProfilesReadyForEntries` writes nothing then, so the
      // run stays open (claimed) for the settled-run sweep to retry the whole finalization.
      // Completing it here would settle the run over a publication that never happened.
      const publication = await markProfilesReadyForEntries(env.BENCH_DB, runId, completePairs);
      if (publication === 'deferred') {
        await markSettledRunInitialized(env.BENCH_DB, runId);
        console.log(
          JSON.stringify({
            event: 'benchmark_paid_run_deferred',
            runId,
            readyEntries: completePairs.length,
          })
        );
        return;
      }
      await releaseProfileClaimsForEntries(env.BENCH_DB, runId, releasedPairs);
      await markRunCompleted(env.BENCH_DB, runId);
      console.log(
        JSON.stringify({
          event: 'benchmark_paid_run_completed',
          runId,
          readyEntries: completePairs.length,
          releasedEntries: releasedPairs.length,
          measuredCases: rows.length,
          skippedSlots: hasCancelledSlots,
          failedLanes: deadLanes.length,
        })
      );
      return;
    }
    // Entries whose lanes all completed become ready unless nearly every case hit one
    // provider rejection; entries with a dead lane fail with their lanes' cause, without
    // taking down the rest of the batch. One attempt per enqueued entry is recorded by
    // `settleProfileRunAttempts` (src/profile-failure-history.ts), which applies the
    // aggregate consecutive-failure streak and skips work that was not attempted,
    // cancelled, fenced, or only copied. Fail first so the ready sweep only catches
    // survivors; every profile UPDATE keeps the run_id + status='running' no-clobber guard.
    const entryFailures = settledEntryFailures(
      enqueuedModels.map(m => ({ model: m.model, variant: m.variant })),
      deadLanes,
      laneFailures,
      rows
    );
    const failureByPair = new Map<string, ProfileFailure>();
    for (const { entry, failure } of entryFailures) {
      failureByPair.set(exactPairKey(entry.model, entry.variant), failure);
    }
    // One try block, fail-first. `markProfilesReadyForRun` has no entry filter —
    // it readies every row still `running` under this run — so it must not run
    // when the per-entry failure did not complete, or a dead lane's partial
    // measurements would be published as a real result. If this throws, the
    // rows stay `running` and the orphan sweep settles them.
    //
    // This runs BEFORE `markRunCompleted`. The orphan reaper spares rows whose
    // run is still in the running set, so settling first leaves it no window:
    // completing first would expose a run older than the stale age — its rows
    // carry claim-time `updated_at`, so the age guard does not cover them — and
    // a sweep landing in between would fail entries that are fully measured.
    //
    // A deferred publication (`deferred` below) is an *outcome*, not a thrown error, so it is
    // handled after the catch: completing the run here would settle it over a measurement that
    // never became ready, and the settled-run sweep only looks at running runs.
    let publicationDeferred = false;
    try {
      await settleProfileRunAttempts(env.BENCH_DB, {
        runId,
        router: state.router,
        engineIdentity: state.engineIdentity,
        repetitions: state.repetitions,
        rows,
        attempts: enqueuedModels.map(m => ({
          entry: { model: m.model, variant: variantFromStorage(m.variant) },
          enqueued: m.enqueued,
          failure: failureByPair.get(exactPairKey(m.model, m.variant)) ?? null,
          cancelled: false,
          fenced: false,
        })),
      });
      const remeasured = await settleRemeasuresForRun(
        env.BENCH_DB,
        runId,
        entryFailures.map(({ entry }) => entry)
      );
      // Recorded before the next transition: if the ready publication then throws, the run must
      // still stay open for this deferral rather than complete over it in the catch below.
      publicationDeferred = remeasured === 'deferred';
      const published = await markProfilesReadyForRun(env.BENCH_DB, runId);
      publicationDeferred = publicationDeferred || published === 'deferred';
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'benchmark_profile_transition_error',
          runId,
          ...formatError(error),
        })
      );
    }
    if (publicationDeferred) {
      // The run must stay open for the settled-run sweep to retry the whole finalization. The
      // marker is what makes the sweep see a settled run, so a failed marker write is *not* a
      // reason to complete: the initialization pass re-materializes a running run without one
      // and the next dispatch retries the same publication. Completing instead would settle the
      // run over an unpublished measurement and strand its claims under a terminal run.
      await markSettledRunInitialized(env.BENCH_DB, runId).catch(error => {
        console.warn(
          JSON.stringify({
            event: 'benchmark_deferred_marker_write_failed',
            runId,
            purpose: state.purpose,
            ...formatError(error),
          })
        );
      });
      console.log(
        JSON.stringify({
          event: 'benchmark_decider_run_deferred',
          runId,
          purpose: state.purpose,
        })
      );
      return;
    }
    await markRunCompleted(env.BENCH_DB, runId);
    console.log(
      JSON.stringify({
        event: 'benchmark_decider_run_completed',
        runId,
        purpose: state.purpose,
        readyEntries: enqueuedModels.length - entryFailures.length,
        failedEntries: entryFailures.length,
        expectedCases: enqueuedModels.length * state.repetitions * caseCount,
        measuredCases: rows.length,
        missingCases: Math.max(
          0,
          enqueuedModels.length * state.repetitions * caseCount - rows.length
        ),
        failedLanes: deadLanes.length,
        errorCases: rows.filter(row => row.error !== null).length,
        timedOutCases: rows.filter(row => row.timed_out === 1).length,
        missingCostCases: rows.filter(row => row.cost_usd === null).length,
      })
    );
    // Fresh registry rows may complete the platform model list, so republish.
    await publishPlatformRoutingTable(env, fetch, state.router).catch(error => {
      console.warn(
        JSON.stringify({
          event: 'routing_table_publish_skipped',
          runId,
          ...formatError(error),
        })
      );
    });
    // Both queues: this queue may have been full, and a pair this run just
    // measured may have been the only pending work the other queue was waiting on.
    await drainQueues(env, 'both', undefined, state.router);
    return;
  }

  // Classifier runs own no registry rows, so there is nothing to settle first.
  await markRunCompleted(env.BENCH_DB, runId);

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
    runId,
    state.router
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
    // Only classifier rows carry route_hit; decider groups stay null.
    const routeGraded = group.filter(r => r.route_hit !== null);
    const p95LatencyMs =
      latencies.length > 0
        ? (latencies[Math.min(latencies.length - 1, Math.ceil(0.95 * latencies.length) - 1)] ??
          null)
        : null;
    const averageTokens = (
      field: 'input_tokens' | 'cached_input_tokens' | 'output_tokens' | 'reasoning_tokens'
    ): number | null => {
      let total = 0;
      let count = 0;
      for (const row of group) {
        const value = row[field];
        if (value !== null) {
          total += value;
          count++;
        }
      }
      return count > 0 ? total / count : null;
    };
    return {
      model,
      variant: variantFromStorage(storedVariant),
      routeKey: routeKey as BenchmarkModelSummary['routeKey'],
      accuracy: Number((group.reduce((a, r) => a + r.score, 0) / group.length).toFixed(4)),
      avgCostUsd: costs.length
        ? Number((costs.reduce((a, r) => a + (r.cost_usd ?? 0), 0) / costs.length).toFixed(8))
        : null,
      avgInputTokens: averageTokens('input_tokens'),
      avgCachedInputTokens: averageTokens('cached_input_tokens'),
      avgOutputTokens: averageTokens('output_tokens'),
      avgReasoningTokens: averageTokens('reasoning_tokens'),
      avgLatencyMs: Math.round(group.reduce((a, r) => a + r.latency_ms, 0) / group.length),
      p50LatencyMs: latencies[Math.floor(latencies.length / 2)] ?? null,
      p95LatencyMs,
      cases: group.length,
      // `avgCostUsd` above divides by exactly this many rows. The console needs
      // it to report a route's total without charging its unpriced cases.
      costedCases: costs.length,
      errors: group.filter(r => r.error !== null).length,
      timeouts: group.filter(r => r.timed_out).length,
      routeAccuracy: routeGraded.length
        ? Number((routeGraded.filter(r => r.route_hit).length / routeGraded.length).toFixed(4))
        : null,
    };
  });
}

/** The deterministic run id a paid request owns, so activation is idempotent. */
export function paidRunIdForRequest(router: AutoRouter, requestId: string): string {
  return `${router === 'frontier' ? 'frontier-' : ''}user-paid-${requestId}`;
}

/**
 * Hand a `ready` registry row with no measuring run (`run_id` missing or empty) back to the
 * queue for one exact pair.
 *
 * Such a row ranks nothing: the quote, the custom table, alias promotion and this launch all
 * refuse it as serving evidence, so a request quoted against it was priced as missing work. The
 * claim could never start that work — `markProfilesRunningForRun` only takes `pending` rows (or
 * `running` under this run), and the re-measure queue refuses a row without provenance — so the
 * request would attach to an owner that never finishes and wait forever. Reopening the row is
 * the paid measurement the owner confirmed.
 *
 * The row's demand flags are left exactly as they were: this repairs provenance, it does not
 * enrol or cancel demand. The confirmed request's claim follows in the same launch, so a pair
 * the platform also wants is measured once — if the platform queue wins that race the request
 * attaches to it and reuses the result, which is the designed behavior for a shared pair.
 *
 * The predicate is the unusable provenance itself, so a row that gained a real measuring run in
 * the window is left alone.
 *
 * Cost: one statement per asked model, each admitted by the registry's full leading primary-key
 * prefix (`router`, `model`), so a large pool costs one bounded seek per model rather than a scan
 * of every profile under the router.
 */
function reopenUnrankedReadyPairStatements(
  db: D1Database,
  current: { router: string; engineIdentity: string; repetitions: number },
  entries: readonly { model: string; variant: string | null }[],
  nowIso: string
): D1PreparedStatement[] {
  if (entries.length === 0) return [];
  // One statement per asked model, not per entry, and never per row of the registry: admission is
  // the full leading primary-key prefix — `router` and `model` bound as equality — so the plan is
  // a bounded seek that also narrows the index to exactly that model's rows. The exact effort is
  // then a membership test against the model's own asked variants, in storage form (the column's
  // key), so a sibling effort of the same model is never reopened.
  const variantsByModel = new Map<string, Set<string>>();
  for (const entry of entries) {
    const model = variantsByModel.get(entry.model) ?? new Set<string>();
    model.add(variantToStorage(entry.variant));
    variantsByModel.set(entry.model, model);
  }
  return [...variantsByModel].map(([model, variants]) =>
    db
      .prepare(
        `UPDATE benchmark_profiles
        SET status = 'pending', run_id = NULL, completed_at = NULL, updated_at = ?1
        WHERE router = ?2 AND model = ?3 AND engine_identity = ?4 AND repetitions = ?5
          AND status = 'ready' AND (run_id IS NULL OR run_id = '')
          AND variant IN (SELECT value FROM json_each(?6))`
      )
      .bind(
        nowIso,
        current.router,
        model,
        current.engineIdentity,
        current.repetitions,
        JSON.stringify([...variants])
      )
  );
}

/** The request id a paid run id names, or null when the id is not a paid run. */
export function paidRequestIdFromRunId(runId: string): string | null {
  const marker = 'user-paid-';
  const index = runId.indexOf(marker);
  if (index === -1) return null;
  const requestId = runId.slice(index + marker.length);
  return requestId.length > 0 ? requestId : null;
}

/**
 * Activate one explicit funded request: claim the exact pairs it will measure, claim the
 * ready pairs it re-measures, and create its run. This is the only way user-purpose work
 * starts; nothing else (subscription sync, pool edits, alias moves, schedules, retries)
 * may call it.
 *
 * Idempotent by the deterministic run id: a repeated call returns the run that already
 * exists. A request with nothing left to measure is completed here so its hold is released
 * instead of waiting for a run that would never be created.
 */
export async function startPaidRequestRun(
  env: Env,
  requestId: string
): Promise<{ runId: string | null; claimed: number; skipped: string[] }> {
  const request = await readPaidBenchmarkRequest(env.BENCH_DB, requestId);
  if (!request) throw new BenchmarkRunConfigError('Paid benchmark request not found.');
  if (request.status !== 'active') {
    return { runId: null, claimed: 0, skipped: ['request_not_active'] };
  }
  const router: AutoRouter = request.router === 'frontier' ? 'frontier' : 'efficient';
  const runId = paidRunIdForRequest(router, request.id);
  const existing = await getRunWithModels(env.BENCH_DB, runId);
  if (existing) return { runId, claimed: 0, skipped: ['run_exists'] };

  const config = await getBenchmarkConfig(env.BENCH_DB, router);
  if (!config) throw new BenchmarkRunConfigError('benchmark config not set');
  const policy = resolveEffectivePolicy(config);
  const identity = resolveRunIdentity(config);
  const engineIdentity = computeEngineIdentity('decider', router);
  if (request.engine_identity !== engineIdentity) {
    throw new BenchmarkPaidPlanError(
      'Paid benchmark request was quoted for a different engine identity.'
    );
  }
  // The confirmed plan is frozen, and it is the authority for both the repetition count and
  // which pairs this launch owns. Read it before anything else so a live policy change can
  // never re-price or re-scope approved work.
  const planRow = await env.BENCH_DB.prepare('SELECT plan FROM paid_benchmark_quotes WHERE id = ?')
    .bind(request.quote_id)
    .first<{ plan: string }>();
  const frozenPlan = planRow ? PaidBenchmarkPlanSchema.safeParse(JSON.parse(planRow.plan)) : null;
  if (!frozenPlan?.success) {
    throw new BenchmarkPaidPlanError('Paid benchmark request has no readable frozen plan.');
  }
  if (frozenPlan.data.repetitions !== policy.deciderRepetitions) {
    throw new BenchmarkPaidPlanError(
      `Paid benchmark request was confirmed for ${frozenPlan.data.repetitions} repetitions but the engine now runs ${policy.deciderRepetitions}.`
    );
  }
  if (frozenPlan.data.engineIdentity !== engineIdentity) {
    throw new BenchmarkPaidPlanError('Paid benchmark request was quoted for a stale engine.');
  }
  // The plan's measurement revision is what its reuse and case slots were priced against. A
  // launch under a different active revision would measure a different case set, so it is
  // rejected before any claim: the owner must take a fresh quote.
  if (frozenPlan.data.revision !== ACTIVE_MEASUREMENT_REVISION) {
    throw new BenchmarkPaidPlanError(
      `Paid benchmark request was confirmed at measurement revision ${frozenPlan.data.revision} but the engine now measures revision ${ACTIVE_MEASUREMENT_REVISION}.`
    );
  }
  // Only pairs this launch owns. A pair the plan marked serving is never re-measured (it is
  // staged as `reused` rows and could redo incompatible probes). A NON-serving pair is
  // launched even when every draw was reused from a partially completed source — it has no
  // live case row at all, yet the run must still ready its profile and assemble the table
  // with zero provider calls.
  const frozenPairs = frozenPlan.data.pairs;
  // The frozen plan is the only source of the entry set: every non-serving pair it names is
  // launched, whether or not any case row is still live. A pair whose every draw was reused
  // from a partially completed source has no live row at all and must still be launched so
  // the run readies its profile and assembles the table with zero provider calls. Only a plan
  // with no non-serving pair at all is `nothing_left`.
  const entries: { model: string; variant: string | null }[] = [];
  const seenPairs = new Set<string>();
  for (const pair of frozenPairs) {
    if (pair.serving) continue;
    // The frozen plan carries the storage variant key ('' = default). Normalize once here so
    // every consumer — registry key, claim, enrollment, display reconcile — compares the same
    // application form; SQL storage keys are re-derived at the boundary.
    const variant = variantFromStorage(pair.variant);
    const key = exactPairKey(pair.model, variant);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    entries.push({ model: pair.model, variant });
  }
  if (entries.length === 0) {
    // Nothing to measure, so the request is complete here. Its pin intent joins the same
    // batch: an all-`serving` quote is exactly the zero-cost alias move whose pin has no
    // other completion path. The outbox row is idempotent (`pins:<requestId>`).
    await env.BENCH_DB.batch([
      ...completePaidBenchmarkRequestStatements(env.BENCH_DB, { requestId: request.id }),
      enqueuePaidPoolPinsStatement(env.BENCH_DB, { requestId: request.id }),
    ]);
    return { runId: null, claimed: 0, skipped: ['nothing_left'] };
  }
  const current = { router, engineIdentity, repetitions: policy.deciderRepetitions };
  const readyRows = await listReadyCurrentProfilesForEntries(env.BENCH_DB, current, entries);
  // Serving evidence is a ready row that names a real measuring run, the same rule the quote
  // and the alias promotion use: a `ready` row with no (or empty) `run_id` ranks nothing and
  // cannot back a pin, so it is not reused here either. Registry variants are stored form, so
  // they normalize to the application form; plan entries carry the storage key and normalize
  // through the same helper, or a default-variant pair never matches its own registry row.
  const readyKeys = new Set(
    readyRows
      .filter(row => row.run_id != null && row.run_id !== '')
      .map(row => exactPairKey(row.model, variantFromStorage(row.variant)))
  );
  const entryKey = (entry: { model: string; variant: string | null }) =>
    exactPairKey(entry.model, variantFromStorage(entry.variant));
  // A pair that became serving after the quote is reused, never remeasured: its ready profile
  // already ranks it, so paying to re-measure it (a probe-case revision promotion included)
  // would bill work the owner never needed. Its display rows move to `reused` from that
  // evidence in the same batch as the read below; if readiness withdrew so a row cannot move,
  // the same batch fails the request durably rather than measuring an unproven pair.
  const quotedReady = entries.filter(entry => readyKeys.has(entryKey(entry)));
  const reusedPairKeys = new Set<string>();
  if (quotedReady.length > 0) {
    const readyPairs = quotedReady.map(entry => ({
      model: entry.model,
      variant: variantToStorage(entry.variant),
    }));
    const results = await env.BENCH_DB.batch([
      ...readyPairs.flatMap(pair =>
        markServingPairReusedStatements(env.BENCH_DB, {
          requestId: request.id,
          router,
          engineIdentity,
          repetitions: policy.deciderRepetitions,
          model: pair.model,
          variant: pair.variant,
        })
      ),
      readLiveRequestPairStatement(env.BENCH_DB, { requestId: request.id, pairs: readyPairs }),
      // Durable guard, same batch: if readiness withdrew in the window, the request fails
      // terminally (retryable, fresh estimate) instead of leaving JS state that a later
      // activation would re-enter and measure. Conditioned on an unproven live row, so a
      // successful reconcile closes nothing.
      ...failUnreconciledServingPairStatements(env.BENCH_DB, {
        requestId: request.id,
        pairs: readyPairs,
        router,
        engineIdentity,
        repetitions: policy.deciderRepetitions,
      }),
    ]);
    const liveRows = (results[readyPairs.length * 2]?.results ?? []) as Array<{
      model: string;
      variant: string;
    }>;
    const liveKeys = new Set(
      liveRows.map(row => exactPairKey(row.model, variantFromStorage(row.variant)))
    );
    for (const entry of quotedReady) {
      const key = entryKey(entry);
      if (!liveKeys.has(key)) reusedPairKeys.add(key);
    }
    // The guard's close is durable: re-read it rather than trusting the batch result, so a
    // failed request can never fall through to a launch.
    const afterReconcile = await readPaidBenchmarkRequest(env.BENCH_DB, request.id);
    if (afterReconcile?.status !== 'active') {
      return { runId: null, claimed: 0, skipped: ['request_not_active'] };
    }
  }
  // The crash-after-success fence. A previous activation may have committed a pair's
  // serving-reuse decision and died before claiming the siblings. That decision is durable, but
  // the registry evidence behind it need not be: the profile can be withdrawn before this retry.
  // Re-deriving readiness now would put the pair back into `measured` and launch a measurement
  // the request already decided to reuse, so the committed rows are the authority — never the
  // current registry read. The pair's other rows may already be terminal under the shared
  // generation (`done`) or a pause; the store's predicate proves the decision by its marker and
  // holds only a live `queued`/`running` row against it.
  const allPairs = entries.map(entry => ({
    model: entry.model,
    variant: variantToStorage(entry.variant),
  }));
  const durableReuse = await readReusedRequestPairStatement(env.BENCH_DB, {
    requestId: request.id,
    pairs: allPairs,
  }).all<{ model: string; variant: string }>();
  for (const row of durableReuse.results) {
    reusedPairKeys.add(exactPairKey(row.model, variantFromStorage(row.variant)));
  }
  const measured = entries.filter(entry => !reusedPairKeys.has(entryKey(entry)));
  if (measured.length === 0) {
    // Every quoted pair is serving now: the request is fully reused, so it completes with its
    // pin intent instead of starting a run nobody needs.
    await env.BENCH_DB.batch([
      ...completePaidBenchmarkRequestStatements(env.BENCH_DB, { requestId: request.id }),
      enqueuePaidPoolPinsStatement(env.BENCH_DB, { requestId: request.id }),
    ]);
    return { runId: null, claimed: 0, skipped: ['already_ready'] };
  }
  // Every remaining entry was proven never-ready for this request, so measuring it cannot
  // duplicate a pair that already serves. A pair the platform has never seen has no registry
  // row at all, and the plan cannot stage it: the explicit confirmation is the authorization,
  // so create exactly those rows here — non-platform demand only, `pending`, requested now —
  // and never for a pair that is already present.
  //
  // The same batch reopens a `ready` row whose `run_id` is missing or empty. Those rows are not
  // serving evidence anywhere (see `readyKeys` above), so this request was quoted as having to
  // measure them, but the claim below can only take a `pending` row or one already claimed by
  // this run: without the reopen the launch would report `pairs_claimed` forever and the request
  // would attach to an owner that never finishes. It is conditioned on the unusable provenance,
  // so a row that gained a real measuring run in the window is untouched.
  await env.BENCH_DB.batch([
    ...enrollPaidPairStatements(env.BENCH_DB, {
      router,
      engineIdentity,
      repetitions: policy.deciderRepetitions,
      entries: measured,
      requestedAt: request.activated_at ?? request.created_at,
    }),
    ...reopenUnrankedReadyPairStatements(
      env.BENCH_DB,
      { router, engineIdentity, repetitions: policy.deciderRepetitions },
      measured,
      request.activated_at ?? request.created_at
    ),
  ]);
  // R33 crash recovery needs no separate clear: the claim predicate accepts
  // `status = 'running' AND run_id = <this deterministic id>`, so a row a crashed activation
  // left claimed under this id is reclaimed by the same call that claims a fresh slot. The
  // id is only ever ours, so nothing else's claims can be touched.
  const claimed = await markProfilesRunningForRun(env.BENCH_DB, runId, measured, current);
  if (claimed.length === 0) {
    // Every pair is claimed by a live run right now. That is attachment, not failure: the
    // cases are being measured, the request keeps its place, and a later activation pass
    // (after the owner settles) reuses the results. Never terminalizes anything here.
    return { runId: null, claimed: 0, skipped: ['pairs_claimed'] };
  }
  const runModelRows: RunModelRow[] = claimed.map(entry => ({
    run_id: runId,
    model: entry.model,
    variant: variantToStorage(entry.variant),
    enqueued: true,
    reasoning_effort: entry.variant,
  }));
  const startedAt = new Date().toISOString();
  try {
    const admission = await insertRun(
      env.BENCH_DB,
      {
        id: runId,
        router,
        accuracy_noise_band: policy.accuracyNoiseBand,
        frontier_min_accuracy_delta: policy.frontierMinAccuracyDelta,
        kind: 'decider',
        startedAt,
        min_accuracy: policy.minAccuracy,
        switch_cost_factor: policy.switchCostFactor,
        best_accuracy_switch_threshold: policy.bestAccuracySwitchThreshold,
        max_concurrency: 0,
        benchmark_user_id: identity.benchmarkUserId,
        benchmark_org_id: identity.benchmarkOrgId,
        repetitions: policy.deciderRepetitions,
        classifier_max_p95_latency_ms: null,
        engine_identity: engineIdentity,
        measurement_revision: ACTIVE_MEASUREMENT_REVISION,
        purpose: 'user',
      },
      runModelRows,
      []
    );
    if (!admission.admitted) {
      // Either the queue is at its cap, or a concurrent launcher of this same request already
      // committed the run row (same deterministic id, so the insert loses). Distinguish them:
      // a committed row means the claims now belong to that winner, so nothing is released.
      const committed = await env.BENCH_DB.prepare('SELECT 1 FROM benchmark_runs WHERE id = ?')
        .bind(runId)
        .first();
      if (committed !== null) return { runId, claimed: 0, skipped: ['run_exists'] };
      // Not admitted and not committed: release only while no row exists, in one write, so a
      // launcher that commits at the same instant keeps its claims.
      await env.BENCH_DB.batch([releaseUncommittedRunClaimsStatement(env.BENCH_DB, runId)]);
      return { runId: null, claimed: 0, skipped: ['queue_full'] };
    }
  } catch (error) {
    // The loser of a concurrent launch collides on `run_models` while the winner's run row is
    // already committed. Its claims are the winner's claims, so the release is guarded on the
    // row being absent — a committed winner keeps them, and this launcher reports the run that
    // exists instead of failing the request.
    await env.BENCH_DB.batch([releaseUncommittedRunClaimsStatement(env.BENCH_DB, runId)]).catch(
      () => {}
    );
    const winner = await env.BENCH_DB.prepare('SELECT 1 FROM benchmark_runs WHERE id = ?')
      .bind(runId)
      .first()
      .catch(() => null);
    if (winner !== null) {
      console.log(JSON.stringify({ event: 'benchmark_paid_launch_lost_race', runId }));
      return { runId, claimed: 0, skipped: ['run_exists'] };
    }
    throw error;
  }
  await env.BENCH_QUEUE.send({
    runId,
    kind: 'decider',
    model: claimed[0].model,
    schedulerWake: true,
  } satisfies BenchmarkJobMessage).catch((error: unknown) => {
    console.warn(
      JSON.stringify({ event: 'benchmark_scheduler_wake_failed', runId, ...formatError(error) })
    );
  });
  console.log(
    JSON.stringify({
      event: 'benchmark_paid_run_started',
      runId,
      requestId: request.id,
      entries: claimed.map(entry => exactPairKey(entry.model, entry.variant)),
    })
  );
  return { runId, claimed: claimed.length, skipped: [] };
}

/**
 * Cancel one platform run: fence its unfinished case generations, stop the subprocesses
 * that are running them, and leave everything settled alone. Registry claims of the run are
 * parked (pre-cutover `requested_at`), so nothing re-admits the same work by itself; an
 * operator's explicit requeue or a new pool membership is needed. The platform routing
 * artifact is never republished here: `publishPlatformRoutingTable` only writes when the
 * desired membership changed.
 *
 * A case shared with a user keeps its platform coverage latch (sticky): cancelling the run
 * cannot move that cost to the user afterwards, and a user whose case ends terminally asks
 * for a fresh quote.
 */
export async function cancelPlatformBenchmarkRun(
  env: Env,
  router: AutoRouter,
  runId: string
): Promise<'cancelled' | 'not_active' | 'not_found'> {
  const loaded = await getRunWithModels(env.BENCH_DB, runId);
  if (!loaded || loaded.run.kind !== 'decider' || loaded.run.router !== router) return 'not_found';
  if (loaded.run.purpose !== 'platform') return 'not_found';
  if (loaded.run.status !== 'running') return 'not_active';

  // Read the generations this run owns before failing it, so the cancel batch names exact
  // rows instead of a status filter that a concurrent settle could widen.
  const running = await env.BENCH_DB.prepare(
    `SELECT engine_identity, model, variant, rep, case_id, generation, executor_token
    FROM benchmark_case_runs WHERE executor_run_id = ? AND status = 'running'`
  )
    .bind(runId)
    .all<{
      engine_identity: string;
      model: string;
      variant: string;
      rep: number;
      case_id: string;
      generation: number;
      executor_token: string;
    }>();

  const cancelStartedAt = Date.now();
  const now = cancelStartedAt;
  const transitionId = `admin-cancel:${runId}`;
  const statements: D1PreparedStatement[] = [];
  const targets: Array<{ key: PaidCaseKey; generation: PaidCaseGeneration }> = [];
  for (const row of running.results) {
    const key: PaidCaseKey = {
      engineIdentity: row.engine_identity,
      model: row.model,
      variant: row.variant,
      rep: row.rep,
      caseId: row.case_id,
    };
    const generation: PaidCaseGeneration = {
      runId,
      token: row.executor_token,
      generation: row.generation,
    };
    targets.push({ key, generation });
    statements.push(
      ...cancelPaidCaseStatements(env.BENCH_DB, {
        key,
        generation,
        reason: 'Platform run cancelled by an operator.',
        transitionId,
        now,
      })
    );
  }
  statements.push(
    ...queuePaidCancellationIntentStatements(
      env.BENCH_DB,
      targets.map(target => ({ key: target.key, generation: target.generation })),
      now
    )
  );
  // One transaction: the fence and the intents commit together, so a crash after this can
  // only lose the external signal (retried from the durable intent), never the fence.
  if (statements.length > 0) await env.BENCH_DB.batch(statements);

  await markRunFailed(env.BENCH_DB, runId, 'Cancelled by an operator.');
  await quarantineProfileClaimsForRuns(env.BENCH_DB, [runId]).catch((error: unknown) => {
    console.warn(
      JSON.stringify({ event: 'benchmark_cancel_park_failed', runId, ...formatError(error) })
    );
  });
  // One exact run id scopes the pass to this cancel's own generations, however many cases
  // it owns, and `createdAfter` keeps a replay from picking up intents another run wrote.
  await deliverPaidCaseCancellations(env, {
    executorRunId: runId,
    createdAfter: cancelStartedAt,
  }).catch(() => {});
  console.log(
    JSON.stringify({
      event: 'benchmark_platform_run_cancelled',
      runId,
      router,
      generations: targets.length,
    })
  );
  return 'cancelled';
}
