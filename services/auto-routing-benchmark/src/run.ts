import { classifyWithOpenRouter } from '@kilocode/auto-routing-contracts/classifier';
import {
  CLASSIFIER_WINNER_KV_KEY,
  ROUTING_TABLE_KV_KEY,
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
import type { RunModelRow } from './db';
import {
  countCaseResults,
  existsNewerCompletedRun,
  getCaseResults,
  getExistingCaseResultIds,
  getLatestSummariesByModel,
  getRunningRun,
  getRunWithModels,
  getSummaries,
  insertRun,
  markRunCompleted,
  markRunFailed,
  markStaleRunsFailed,
  replaceModelSummaries,
  saveRoutingTable,
  upsertCaseResult,
  type CaseResultRow,
  type PriorModelResult,
} from './db';
import { gradeClassifierOutput, runDeciderCheck } from './grading';
import { createOpenRouterClient } from './openrouter';
import { buildRoutingTable } from './routing-table-builder';
import {
  destroyDeciderCliContainer,
  isRetryableContainerAvailabilityError,
  runDeciderCaseViaCli,
  warmUpCliContainer,
} from './cli-runner';
import { parsePersistedReasoningEffort } from './reasoning-effort';
import { pickClassifierWinner } from './winner';

export type BenchmarkJobMessage = {
  runId: string;
  kind: BenchmarkKind;
  model: string;
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

// Cloudflare Containers cap for the benchmark runner. Sharded decider fan-out
// uses this as the live-container budget.
export const DECIDER_CONTAINER_INSTANCE_CAP = 100;

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
  maxLiveContainers = DECIDER_CONTAINER_INSTANCE_CAP,
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
      await markRunFailed(
        env.BENCH_DB,
        runId,
        `enqueue failed after ${i} of ${messages.length} messages: ${formatError(error).error}`
      ).catch(() => {});
      throw error;
    }
  }
}

const STALE_RUN_MAX_AGE_MS = 6 * 3600_000;

// Fails any run still 'running' past the stale threshold (queue retries
// exhausted / dead-lettered). Called both before starting a run and when
// listing runs, so a wedged run is recovered without depending on a new run
// being started (the UI disables Start while a run shows 'running').
export async function sweepStaleRuns(db: D1Database): Promise<void> {
  await markStaleRunsFailed(db, new Date(Date.now() - STALE_RUN_MAX_AGE_MS).toISOString());
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

/** Pure helper: produces the initial sendBatch bodies for a decider run.
 * Extracted for unit-testability; the shape is models × reps messages. Later
 * chunks are chained by processDeciderJob after the previous chunk completes.
 */
export function buildDeciderMessages(
  runId: string,
  kind: BenchmarkKind,
  modelIds: string[],
  repetitions: number,
  chunks: readonly (readonly { id: string }[])[],
  maxLiveContainers: number = DECIDER_CONTAINER_INSTANCE_CAP
): { body: BenchmarkJobMessage }[] {
  const shardCount = computeDeciderShardCount({
    modelCount: modelIds.length,
    repetitions,
    chunkCount: chunks.length,
    maxLiveContainers,
  });
  if (shardCount === 0) return [];
  return modelIds.flatMap(model =>
    Array.from({ length: repetitions }, (_, rep) =>
      Array.from({ length: shardCount }, (_, shard) => {
        const chunkCases = chunks[shard];
        if (!chunkCases) return [];
        return [
          {
            body: {
              runId,
              kind,
              model,
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
  message: Pick<BenchmarkJobMessage, 'runId' | 'model' | 'rep' | 'chunk' | 'shard'>
): string {
  return `${message.runId}:${message.model}:${message.rep ?? 0}:${message.shard ?? 0}`;
}

export function buildClassifierMessages(
  runId: string,
  modelIds: string[],
  repetitions: number,
  chunks: readonly (readonly { id: string }[])[]
): { body: BenchmarkJobMessage }[] {
  return modelIds.flatMap(model =>
    Array.from({ length: repetitions }, (_, rep) =>
      chunks.map((chunkCases, chunk) => ({
        body: {
          runId,
          kind: 'classifier',
          model,
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

// Thrown when the saved benchmark config would exceed a hard runtime limit.
// The admin route maps it to HTTP 400 so operators can fix config instead of
// starting a run that will immediately hit platform capacity.
export class BenchmarkRunConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkRunConfigError';
  }
}

function validateDeciderContainerBudget({
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

export async function startRun(
  env: Env,
  kind: BenchmarkKind,
  options: { force?: boolean } = {}
): Promise<{ runId: string; enqueuedModels: number; skippedModels: string[] }> {
  // Stale-run sweeper: fail dead 'running' runs first so a wedged run can't
  // block new ones and the admin panel shows the truth.
  await sweepStaleRuns(env.BENCH_DB);

  const config = await getBenchmarkConfig(env.BENCH_DB);
  if (!config) {
    throw new Error('benchmark config not set: save it in the admin panel before starting a run');
  }

  // One active run per kind. The unique partial index is the atomic backstop;
  // this pre-check turns the common case (a run already going) into a clean
  // RunAlreadyActiveError instead of an insert-constraint failure.
  const activeRun = await getRunningRun(env.BENCH_DB, kind);
  if (activeRun) {
    throw new RunAlreadyActiveError(kind, activeRun.id);
  }
  const repetitions =
    kind === 'classifier' ? config.classifierRepetitions : config.deciderRepetitions;
  const models =
    kind === 'classifier' ? config.classifierModels : config.deciderModels.map(m => m.id);

  const engineIdentity = computeEngineIdentity(kind);
  const reasoningEffortFor = (modelId: string): string | null =>
    kind === 'classifier'
      ? null
      : (config.deciderModels.find(m => m.id === modelId)?.reasoningEffort ?? null);

  // Models with prior results are skipped (their latest summaries are carried
  // into this run's aggregate) unless the admin forces a full re-run. A prior
  // result is only carried when it was measured under the SAME benchmark
  // identity — engine identity (dataset + grading/CLI version), repetitions,
  // and the model's reasoning_effort — so a config/dataset change re-benchmarks
  // the model instead of pairing current serving config with stale numbers.
  const priorByModel = options.force
    ? new Map<string, PriorModelResult>()
    : await getLatestSummariesByModel(env.BENCH_DB, kind);
  const isCarryable = (modelId: string): boolean => {
    const prior = priorByModel.get(modelId);
    return (
      prior !== undefined &&
      prior.engineIdentity === engineIdentity &&
      prior.repetitions === repetitions &&
      (prior.reasoningEffort ?? null) === reasoningEffortFor(modelId)
    );
  };
  const enqueuedModelIds = models.filter(m => !isCarryable(m));
  const skippedModels = models.filter(m => isCarryable(m));
  const carriedSummaries = skippedModels.flatMap(m => priorByModel.get(m)?.summaries ?? []);

  // Decider runs execute through the kilo CLI under a real Kilo user's
  // identity/billing. Fail fast (before inserting the run) when that user
  // isn't configured so the admin POST surfaces the misconfiguration.
  if (kind === 'decider' && enqueuedModelIds.length > 0 && !config.benchmarkUserId) {
    throw new Error(
      'benchmark user not configured: set benchmarkUserId before running the decider benchmark'
    );
  }
  const maxLiveDeciderContainers = Math.min(config.maxConcurrency, DECIDER_CONTAINER_INSTANCE_CAP);
  if (kind === 'decider') {
    validateDeciderContainerBudget({
      modelCount: enqueuedModelIds.length,
      repetitions,
      maxLiveContainers: maxLiveDeciderContainers,
    });
  }

  const startedAt = new Date().toISOString();
  const runId = `${kind}-${startedAt.replace(/[:.]/g, '-')}`;

  // Build run_models rows for ALL models of this run's kind.
  const runModelRows: RunModelRow[] = models.map(modelId => ({
    run_id: runId,
    model: modelId,
    enqueued: enqueuedModelIds.includes(modelId),
    reasoning_effort: reasoningEffortFor(modelId),
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
        max_concurrency: config.maxConcurrency,
        benchmark_user_id: config.benchmarkUserId,
        benchmark_org_id: config.benchmarkOrgId,
        repetitions,
        classifier_max_p95_latency_ms:
          kind === 'classifier' ? config.classifierMaxP95LatencyMs : null,
        engine_identity: engineIdentity,
      },
      runModelRows,
      carriedSummaries
    );
  } catch (error) {
    // The pre-check already passed, so an insert failure is almost certainly a
    // race losing the one-running-per-kind unique index. Re-read the winner and
    // surface a clean conflict rather than a 500.
    const winner = await getRunningRun(env.BENCH_DB, kind).catch(() => undefined);
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
      enqueuedModels: enqueuedModelIds,
      skippedModels,
    })
  );

  if (enqueuedModelIds.length === 0) {
    // Everything already has results: complete immediately and republish the
    // aggregate so config-only changes (model removed, threshold tweaked)
    // take effect without re-running any model. The state mirrors the rows
    // insertRun just wrote, so no re-read is needed.
    await finalizeRunIfComplete(env, runId, kind, {
      maxConcurrency: config.maxConcurrency,
      minAccuracy: config.minAccuracy,
      switchCostFactor: config.switchCostFactor,
      benchmarkUserId: config.benchmarkUserId,
      benchmarkOrgId: config.benchmarkOrgId,
      models: runModelRows,
      repetitions,
      classifierMaxP95LatencyMs: kind === 'classifier' ? config.classifierMaxP95LatencyMs : null,
      startedAt,
    });
    return { runId, enqueuedModels: 0, skippedModels };
  }

  if (kind === 'classifier') {
    const chunks = chunkArray(CLASSIFIER_CASES, CLASSIFIER_CHUNK_SIZE);
    const messages = buildClassifierMessages(runId, enqueuedModelIds, repetitions, chunks);
    await enqueueRunMessages(env, runId, messages);
    return { runId, enqueuedModels: enqueuedModelIds.length, skippedModels };
  }

  // Decider: seed as many shard lanes as fit under the live-container cap. Each
  // completed chunk enqueues the next chunk for the same lane, so one stable
  // container handles chunk N, N+shardCount, N+(2*shardCount), ...
  const chunks = chunkArray(DECIDER_CASES, DECIDER_CHUNK_SIZE);
  const messages = buildDeciderMessages(
    runId,
    kind,
    enqueuedModelIds,
    repetitions,
    chunks,
    maxLiveDeciderContainers
  );
  await enqueueRunMessages(env, runId, messages);
  return { runId, enqueuedModels: enqueuedModelIds.length, skippedModels };
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

type RunState = {
  maxConcurrency: number;
  minAccuracy: number;
  switchCostFactor: number;
  benchmarkUserId: string | null;
  benchmarkOrgId: string | null;
  models: RunModelRow[];
  repetitions: number;
  classifierMaxP95LatencyMs: number | null;
  startedAt: string;
};

async function getRunState(env: Env, runId: string): Promise<RunState> {
  // Snapshots taken at startRun time so a mid-run admin edit can't skew them.
  const result = await getRunWithModels(env.BENCH_DB, runId);
  if (!result) throw new Error(`unknown run ${runId}`);
  const { run, models } = result;
  return {
    maxConcurrency: run.max_concurrency,
    minAccuracy: run.min_accuracy,
    switchCostFactor: run.switch_cost_factor,
    benchmarkUserId: run.benchmark_user_id,
    benchmarkOrgId: run.benchmark_org_id,
    models,
    repetitions: run.repetitions,
    classifierMaxP95LatencyMs: run.classifier_max_p95_latency_ms,
    startedAt: run.started_at,
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
    // startRun fails fast before enqueueing, so this only happens if the run
    // snapshot was tampered with; throwing lets the queue retry/dead-letter.
    throw new Error(`run ${message.runId} has no benchmarkUserId`);
  }

  const rep = message.rep ?? 0;
  const chunk = message.chunk ?? 0;
  const shard = message.shard ?? 0;
  const shardCount = message.shardCount ?? 1;
  const instanceName = getDeciderContainerInstanceName(message);

  const existingCaseIds = await getExistingCaseResultIds(env.BENCH_DB, {
    runId: message.runId,
    model: message.model,
    rep,
    caseIds: cases.map(c => c.id),
  });
  const casesToRun = cases.filter(c => !existingCaseIds.has(c.id));

  // Reasoning effort comes from the run snapshot (run_models row), not live config.
  const modelRow = state.models.find(m => m.model === message.model);
  const reasoningEffort = modelRow?.reasoning_effort ?? null;

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
          reasoningEffort,
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
            reasoningEffort,
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
          failedRow(message, benchCase.id, taxonomyRouteKey(benchCase), startedAt, error, rep)
        );
      }
    });
  }

  const hasNextChunk = await enqueueNextDeciderChunkIfNeeded(
    env,
    message,
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

async function finalizeRunIfComplete(
  env: Env,
  runId: string,
  kind: BenchmarkKind,
  // Run snapshot already loaded by the caller (startRun / processJob).
  state: RunState
): Promise<void> {
  const enqueuedModels = state.models.filter(m => m.enqueued);
  const caseCount = kind === 'classifier' ? CLASSIFIER_CASES.length : DECIDER_CASES.length;
  const expected = enqueuedModels.length * caseCount * state.repetitions;
  const actual = await countCaseResults(env.BENCH_DB, runId);

  if (actual < expected) return;

  // Two consumers may both see completion and both aggregate — harmless:
  // identical deterministic inputs → identical summaries; replaceModelSummaries
  // is a batched delete+insert; markRunCompleted guards on status='running'.
  const rows = await getCaseResults(env.BENCH_DB, runId);
  // Fresh results (enqueued models). Carried summaries (skipped models) stay in
  // model_summaries with carried=true and are included via getSummaries below.
  const freshSummaries = summarize(rows, kind);
  await replaceModelSummaries(env.BENCH_DB, runId, freshSummaries);
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

  if (kind === 'decider' && !supersededByNewer) {
    const generatedAt = new Date().toISOString();
    try {
      // Built from the run's own model snapshot, not live config, so a mid-run
      // admin edit can't skew the published table.
      const deciderModels: BenchmarkDeciderModel[] = state.models.map(m => ({
        id: m.model,
        reasoningEffort: parsePersistedReasoningEffort(m.reasoning_effort),
      }));
      const table = buildRoutingTable({
        runId,
        generatedAt,
        minAccuracy: state.minAccuracy,
        switchCostFactor: state.switchCostFactor,
        deciderModels,
        summaries: allSummaries,
      });
      await saveRoutingTable(env.BENCH_DB, table, generatedAt);
      // Clear KV so the auto-routing worker repopulates from D1 on next request.
      await env.AUTO_ROUTING_CONFIG.delete(ROUTING_TABLE_KV_KEY);
      console.log(
        JSON.stringify({ event: 'routing_table_published', runId, version: table.version })
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'routing_table_publish_skipped',
          runId,
          ...formatError(error),
        })
      );
    }
  }

  console.log(
    JSON.stringify({
      event: 'benchmark_run_completed',
      runId,
      kind,
      summaries: allSummaries,
    })
  );
}

export function summarize(rows: CaseResultRow[], kind: BenchmarkKind): BenchmarkModelSummary[] {
  // Group by "model route-key" using a plain reduce so this works in all runtimes.
  // Classifier rows use '*' because classification has no decider taxonomy route.
  const groups = new Map<string, CaseResultRow[]>();
  for (const row of rows) {
    const routeKey = kind === 'classifier' ? '*' : (row.route_key ?? '*');
    const key = `${row.model}\0${routeKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  return [...groups.entries()].map(([key, group]) => {
    const [model, routeKey] = key.split('\0');
    const latencies = group.map(r => r.latency_ms).toSorted((a, b) => a - b);
    const costs = group.filter(r => r.cost_usd !== null);
    const p95LatencyMs =
      latencies.length > 0
        ? (latencies[Math.min(latencies.length - 1, Math.ceil(0.95 * latencies.length) - 1)] ??
          null)
        : null;
    return {
      model,
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
