import { classifyWithOpenRouter } from '@kilocode/auto-routing-contracts/classifier';
import {
  BenchmarkConfigSchema,
  BenchmarkModelSummarySchema,
  CLASSIFIER_WINNER_KV_KEY,
  ROUTING_TABLE_KV_KEY,
  type BenchmarkConfig,
  type BenchmarkKind,
  type BenchmarkModelSummary,
  type ClassifierWinner,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import * as z from 'zod';
import { getBenchmarkConfig } from './config';
import { CLASSIFIER_CASES } from './datasets/classifier-cases';
import { DECIDER_CASES } from './datasets/decider-cases';
import {
  countCaseResults,
  getCaseResults,
  getLatestSummariesByModel,
  getRun,
  insertRun,
  markRunCompleted,
  markStaleRunsFailed,
  replaceModelSummaries,
  saveRoutingTable,
  upsertCaseResult,
  type CaseResultRow,
} from './db';
import { gradeClassifierOutput, runDeciderCheck } from './grading';
import { createOpenRouterClient } from './openrouter';
import { buildRoutingTable } from './routing-table-builder';
import { runDeciderCaseViaCli } from './cli-runner';

export type BenchmarkJobMessage = {
  runId: string;
  kind: BenchmarkKind;
  model: string;
  // Decider only: the case ids this message is responsible for, plus the chunk
  // index used to key the container instance. Absent for classifier messages.
  caseIds?: string[];
  chunk?: number;
};

export const BenchmarkJobMessageSchema = z.object({
  runId: z.string().min(1),
  kind: z.enum(['classifier', 'decider']),
  model: z.string().min(1),
  caseIds: z.array(z.string().min(1)).optional(),
  chunk: z.number().int().min(0).optional(),
});

// Decider cases run through the real `kilo` CLI in a container (up to ~3 min
// each). Chunking caps how many cases a single queue invocation processes so
// each stays well under CF's wall-clock limit.
const DECIDER_CHUNK_SIZE = 10;

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

const STALE_RUN_MAX_AGE_MS = 6 * 3600_000;

// Per-run execution state stored in benchmark_runs.runtime_json: which models
// were actually enqueued, and the latest prior summaries carried forward for
// models skipped because they already had results.
const RunRuntimeSchema = z.object({
  enqueuedModels: z.array(z.string()),
  carriedSummaries: z.array(BenchmarkModelSummarySchema),
});
type RunRuntime = z.infer<typeof RunRuntimeSchema>;

export async function startRun(
  env: Env,
  kind: BenchmarkKind,
  options: { force?: boolean } = {}
): Promise<{ runId: string; enqueuedModels: number; skippedModels: string[] }> {
  // Stale-run sweeper: anything still 'running' after 6h is dead (queue
  // retries exhausted); fail it so the admin panel shows the truth.
  await markStaleRunsFailed(
    env.BENCH_DB,
    new Date(Date.now() - STALE_RUN_MAX_AGE_MS).toISOString()
  );

  const config = await getBenchmarkConfig(env.BENCH_DB);
  const models =
    kind === 'classifier' ? config.classifierModels : config.deciderModels.map(m => m.id);

  // Models with prior results are skipped (their latest summaries are carried
  // into this run's aggregate) unless the admin forces a full re-run.
  const priorSummaries = options.force
    ? new Map<string, BenchmarkModelSummary[]>()
    : await getLatestSummariesByModel(env.BENCH_DB, kind);
  const enqueuedModels = models.filter(m => !priorSummaries.has(m));
  const skippedModels = models.filter(m => priorSummaries.has(m));
  const carriedSummaries = skippedModels.flatMap(m => priorSummaries.get(m) ?? []);

  // Decider runs execute through the kilo CLI under a real Kilo user's
  // identity/billing. Fail fast (before inserting the run) when that user
  // isn't configured so the admin POST surfaces the misconfiguration.
  if (kind === 'decider' && enqueuedModels.length > 0 && !config.benchmarkUserId) {
    throw new Error(
      'benchmark user not configured: set benchmarkUserId before running the decider benchmark'
    );
  }

  const runId = `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runtime: RunRuntime = { enqueuedModels, carriedSummaries };
  await insertRun(env.BENCH_DB, {
    id: runId,
    kind,
    startedAt: new Date().toISOString(),
    configJson: JSON.stringify(config),
    runtimeJson: JSON.stringify(runtime),
  });

  console.log(
    JSON.stringify({ event: 'benchmark_run_started', runId, kind, enqueuedModels, skippedModels })
  );

  if (enqueuedModels.length === 0) {
    // Everything already has results: complete immediately and republish the
    // aggregate so config-only changes (model removed, threshold tweaked)
    // take effect without re-running any model.
    await finalizeRunIfComplete(env, runId, kind);
    return { runId, enqueuedModels: 0, skippedModels };
  }

  if (kind === 'classifier') {
    await env.BENCH_QUEUE.sendBatch(
      enqueuedModels.map(model => ({ body: { runId, kind, model } satisfies BenchmarkJobMessage }))
    );
    return { runId, enqueuedModels: enqueuedModels.length, skippedModels };
  }

  // Decider: one message per (model, chunk) so each queue invocation stays
  // bounded. finalizeRunIfComplete expects enqueuedModels × DECIDER_CASES rows.
  const chunks = chunkArray(DECIDER_CASES, DECIDER_CHUNK_SIZE);
  const messages = enqueuedModels.flatMap(model =>
    chunks.map((chunkCases, chunk) => ({
      body: {
        runId,
        kind,
        model,
        chunk,
        caseIds: chunkCases.map(c => c.id),
      } satisfies BenchmarkJobMessage,
    }))
  );
  await env.BENCH_QUEUE.sendBatch(messages);
  return { runId, enqueuedModels: enqueuedModels.length, skippedModels };
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
  const config = await getRunConfig(env, message.runId);

  if (message.kind === 'classifier') {
    // Create the OpenRouter client inside processJob — no module-scope transport clients.
    const client = await createOpenRouterClient(env);
    await runCasesWithConcurrency(CLASSIFIER_CASES, config.maxConcurrency, async benchCase => {
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
          tier: null,
          score,
          latency_ms: Math.round(performance.now() - startedAt),
          cost_usd: result.cost,
          detail_json: JSON.stringify({
            classification: result.fallback ? null : result.classification,
            fallback: result.fallback?.reason ?? null,
            retried: result.retried ?? false,
          }),
          error: null,
        });
      } catch (error) {
        await upsertCaseResult(
          env.BENCH_DB,
          failedRow(message, benchCase.id, null, startedAt, error)
        );
      }
    });
  } else {
    await processDeciderJob(env, message, config);
  }

  await finalizeRunIfComplete(env, message.runId, message.kind);
}

async function processDeciderJob(
  env: Env,
  message: BenchmarkJobMessage,
  config: BenchmarkConfig
): Promise<void> {
  // Only the cases this message owns (chunked); fall back to the full set for
  // legacy/un-chunked messages.
  const cases =
    message.caseIds && message.caseIds.length > 0
      ? DECIDER_CASES.filter(c => message.caseIds?.includes(c.id))
      : DECIDER_CASES;

  // Defensive guard mirroring the startRun fail-fast: if the run snapshot has
  // no benchmark user, every case in this chunk fails with a clear error so
  // the run still completes and surfaces the misconfiguration.
  if (!config.benchmarkUserId) {
    for (const benchCase of cases) {
      await upsertCaseResult(env.BENCH_DB, {
        run_id: message.runId,
        model: message.model,
        case_id: benchCase.id,
        tier: benchCase.tier,
        score: 0,
        latency_ms: 0,
        cost_usd: null,
        detail_json: null,
        error: 'benchmark user not configured',
      });
    }
    return;
  }

  // Fetch a short-lived user token ONCE per queue message. Non-OK throws so the
  // queue retries the message. The token is never logged.
  const kiloToken = await fetchBenchmarkUserToken(env, config.benchmarkUserId);
  const instanceName = `${message.runId}:${message.model}:${message.chunk ?? 0}`;
  const reasoningEffort =
    config.deciderModels.find(m => m.id === message.model)?.reasoningEffort ?? null;

  // The CLI performs a one-time sqlite migration on each fresh container
  // instance; concurrent first runs against the migrating database end with
  // empty event streams (exit 0, zero events). One sequential warmup run
  // completes the migration before the concurrent case loop starts.
  await runDeciderCaseViaCli(env, {
    instanceName,
    model: message.model,
    benchCase: {
      id: 'warmup',
      tier: 'low',
      taskType: 'implementation',
      systemPrompt: 'You are a terse assistant.',
      userPrompt: 'Reply with exactly: ok',
      maxTokens: 512,
      check: { kind: 'exact', value: 'ok' },
    },
    kiloToken,
  }).catch(() => {});

  // Concurrency 1: the CLI's sqlite state in the container is not safe under
  // concurrent sessions (partial-migration crashes); the container serializes
  // too, so higher concurrency here would only hold HTTP requests open.
  await runCasesWithConcurrency(cases, 1, async benchCase => {
    const startedAt = performance.now();
    try {
      let result = await runDeciderCaseViaCli(env, {
        instanceName,
        model: message.model,
        benchCase,
        kiloToken,
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
        tier: benchCase.tier,
        score: succeeded ? 1 : 0,
        latency_ms: result.latencyMs,
        cost_usd: result.costUsd,
        detail_json: JSON.stringify({
          exitCode: result.exitCode,
          outputPrefix: result.text.slice(0, 200),
          eventCount: result.eventCount,
          lastEventTypes: result.lastEventTypes,
          retried,
        }),
        error: result.exitCode !== 0 ? result.stderrTail.slice(0, 500) : null,
      });
    } catch (error) {
      await upsertCaseResult(
        env.BENCH_DB,
        failedRow(message, benchCase.id, benchCase.tier, startedAt, error)
      );
    }
  });
}

const TokenResponseSchema = z.object({ token: z.string().min(1), expiresAt: z.string() });

// Calls apps/web's internal endpoint to mint a short-lived user API token for
// the decider CLI. Never logs the token.
export async function fetchBenchmarkUserToken(env: Env, userId: string): Promise<string> {
  const secret = await env.INTERNAL_API_SECRET_PROD.get();
  const response = await fetch(
    `${env.KILO_WEB_API_BASE_URL}/api/internal/auto-routing-benchmark/token`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ userId }),
    }
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`token mint failed: HTTP ${response.status} ${detail}`);
  }
  const parsed = TokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('token mint returned unexpected response shape');
  }
  return parsed.data.token;
}

function failedRow(
  message: BenchmarkJobMessage,
  caseId: string,
  tier: string | null,
  startedAt: number,
  error: unknown
): CaseResultRow {
  return {
    run_id: message.runId,
    model: message.model,
    case_id: caseId,
    tier,
    score: 0,
    latency_ms: Math.round(performance.now() - startedAt),
    cost_usd: null,
    detail_json: null,
    error: JSON.stringify(formatError(error)).slice(0, 500),
  };
}

async function getRunState(
  env: Env,
  runId: string
): Promise<{ config: BenchmarkConfig; runtime: RunRuntime }> {
  // Snapshots taken at startRun time so a mid-run admin edit can't skew them.
  const run = await getRun(env.BENCH_DB, runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const config = BenchmarkConfigSchema.parse(JSON.parse(run.config_json));
  const runtime = run.runtime_json
    ? RunRuntimeSchema.parse(JSON.parse(run.runtime_json))
    : // Rows written before runtime_json existed ran every configured model.
      {
        enqueuedModels:
          run.kind === 'classifier' ? config.classifierModels : config.deciderModels.map(m => m.id),
        carriedSummaries: [],
      };
  return { config, runtime };
}

async function getRunConfig(env: Env, runId: string): Promise<BenchmarkConfig> {
  return (await getRunState(env, runId)).config;
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

async function finalizeRunIfComplete(env: Env, runId: string, kind: BenchmarkKind): Promise<void> {
  const { config, runtime } = await getRunState(env, runId);
  const caseCount = kind === 'classifier' ? CLASSIFIER_CASES.length : DECIDER_CASES.length;
  const expected = runtime.enqueuedModels.length * caseCount;
  const actual = await countCaseResults(env.BENCH_DB, runId);

  if (actual < expected) return;

  // Two consumers may both see completion and both aggregate — harmless:
  // identical deterministic inputs → identical summaries; replaceModelSummaries
  // is a batched delete+insert; markRunCompleted guards on status='running';
  // KV put is idempotent.
  const rows = await getCaseResults(env.BENCH_DB, runId);
  // Fresh results plus the carried-forward summaries of skipped models.
  const summaries = [...summarize(rows, kind), ...runtime.carriedSummaries];
  await replaceModelSummaries(env.BENCH_DB, runId, summaries);
  await markRunCompleted(env.BENCH_DB, runId);

  if (kind === 'classifier') {
    const winner = pickClassifierWinner(summaries, config.minAccuracy);
    if (winner) {
      const payload: ClassifierWinner = {
        model: winner.model,
        runId,
        accuracy: winner.accuracy,
        generatedAt: new Date().toISOString(),
      };
      await env.AUTO_ROUTING_CONFIG.put(CLASSIFIER_WINNER_KV_KEY, JSON.stringify(payload));
      console.log(
        JSON.stringify({ event: 'classifier_winner_published', runId, model: winner.model })
      );
    } else {
      console.warn(JSON.stringify({ event: 'classifier_winner_skipped', runId }));
    }
  }

  if (kind === 'decider') {
    const generatedAt = new Date().toISOString();
    try {
      const table = buildRoutingTable({ runId, generatedAt, config, summaries });
      const tableJson = JSON.stringify(table);
      await saveRoutingTable(env.BENCH_DB, runId, generatedAt, tableJson);
      await env.AUTO_ROUTING_CONFIG.put(ROUTING_TABLE_KV_KEY, tableJson);
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
      summaries,
    })
  );
}

// Same bang-for-buck rule as the routing table, applied to classifier
// summaries (tier '*'): cheapest candidate meeting the accuracy threshold,
// else the most accurate one. Null when there are no graded summaries.
export function pickClassifierWinner(
  summaries: BenchmarkModelSummary[],
  minAccuracy: number
): BenchmarkModelSummary | null {
  const graded = summaries.filter(s => s.tier === '*' && s.cases > 0);
  if (graded.length === 0) return null;
  const cost = (s: BenchmarkModelSummary) => s.avgCostUsd ?? Number.POSITIVE_INFINITY;
  const meeting = graded.filter(s => s.accuracy >= minAccuracy);
  if (meeting.length > 0) {
    return meeting.toSorted((a, b) => cost(a) - cost(b) || b.accuracy - a.accuracy)[0];
  }
  return graded.toSorted((a, b) => b.accuracy - a.accuracy || cost(a) - cost(b))[0];
}

export function summarize(rows: CaseResultRow[], kind: BenchmarkKind): BenchmarkModelSummary[] {
  // Group by "model tier-key" using a plain reduce so this works in all runtimes.
  // Classifier rows use '*' as the tier (no tiering); decider rows use the actual tier
  // (falling back to '*' when tier is null).
  const groups = new Map<string, CaseResultRow[]>();
  for (const row of rows) {
    const tierKey = kind === 'classifier' ? '*' : (row.tier ?? '*');
    const key = `${row.model}\0${tierKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  return [...groups.entries()].map(([key, group]) => {
    const [model, tier] = key.split('\0');
    const latencies = group.map(r => r.latency_ms).toSorted((a, b) => a - b);
    const costs = group.filter(r => r.cost_usd !== null);
    return {
      model,
      tier: tier as BenchmarkModelSummary['tier'],
      accuracy: Number((group.reduce((a, r) => a + r.score, 0) / group.length).toFixed(4)),
      avgCostUsd: costs.length
        ? Number((costs.reduce((a, r) => a + (r.cost_usd ?? 0), 0) / costs.length).toFixed(8))
        : null,
      avgLatencyMs: Math.round(group.reduce((a, r) => a + r.latency_ms, 0) / group.length),
      p50LatencyMs: latencies[Math.floor(latencies.length / 2)] ?? null,
      cases: group.length,
      errors: group.filter(r => r.error !== null).length,
    };
  });
}
