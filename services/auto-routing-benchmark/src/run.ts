import { classifyWithOpenRouter } from '@kilocode/auto-routing-contracts/classifier';
import {
  BenchmarkConfigSchema,
  ROUTING_TABLE_KV_KEY,
  type BenchmarkConfig,
  type BenchmarkKind,
  type BenchmarkModelSummary,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import * as z from 'zod';
import { getBenchmarkConfig } from './config';
import { CLASSIFIER_CASES } from './datasets/classifier-cases';
import { DECIDER_CASES } from './datasets/decider-cases';
import {
  countCaseResults,
  getCaseResults,
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

export type BenchmarkJobMessage = { runId: string; kind: BenchmarkKind; model: string };

export const BenchmarkJobMessageSchema = z.object({
  runId: z.string().min(1),
  kind: z.enum(['classifier', 'decider']),
  model: z.string().min(1),
});

const STALE_RUN_MAX_AGE_MS = 6 * 3600_000;

export async function startRun(
  env: Env,
  kind: BenchmarkKind
): Promise<{ runId: string; enqueuedModels: number }> {
  // Stale-run sweeper: anything still 'running' after 6h is dead (queue
  // retries exhausted); fail it so the admin panel shows the truth.
  await markStaleRunsFailed(env.BENCH_DB, new Date(Date.now() - STALE_RUN_MAX_AGE_MS).toISOString());

  const config = await getBenchmarkConfig(env.BENCH_DB);
  const models = kind === 'classifier' ? config.classifierModels : config.deciderModels.map(m => m.id);
  const runId = `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await insertRun(env.BENCH_DB, {
    id: runId,
    kind,
    startedAt: new Date().toISOString(),
    configJson: JSON.stringify(config),
  });
  await env.BENCH_QUEUE.sendBatch(
    models.map(model => ({ body: { runId, kind, model } satisfies BenchmarkJobMessage }))
  );
  console.log(JSON.stringify({ event: 'benchmark_run_started', runId, kind, models }));
  return { runId, enqueuedModels: models.length };
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
  // Create the OpenRouter client inside processJob — no module-scope transport clients.
  const client = await createOpenRouterClient(env);

  if (message.kind === 'classifier') {
    await runCasesWithConcurrency(CLASSIFIER_CASES, config.maxConcurrency, async benchCase => {
      const startedAt = performance.now();
      try {
        const result = await classifyWithOpenRouter(client, benchCase.input, message.model);
        const score = result.fallback ? 0 : gradeClassifierOutput(benchCase.expected, result.classification);
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
        await upsertCaseResult(env.BENCH_DB, failedRow(message, benchCase.id, null, startedAt, error));
      }
    });
  } else {
    // Determinism note: temperature 0, fixed maxTokens, pinned prompts, mechanical checks.
    // Provider-side nondeterminism can't be fully eliminated, which is why grading is
    // binary on a single canonical answer.
    await runCasesWithConcurrency(DECIDER_CASES, config.maxConcurrency, async benchCase => {
      const startedAt = performance.now();
      try {
        const result = await client.chat.send({
          chatRequest: {
            model: message.model,
            messages: [
              { role: 'system', content: benchCase.systemPrompt },
              { role: 'user', content: benchCase.userPrompt },
            ],
            stream: false,
            temperature: 0,
            maxTokens: benchCase.maxTokens,
          },
        });
        const content: unknown = result.choices[0]?.message.content;
        const text = typeof content === 'string' ? content : '';
        const passed = text.length > 0 && runDeciderCheck(benchCase.check, text);
        await upsertCaseResult(env.BENCH_DB, {
          run_id: message.runId,
          model: message.model,
          case_id: benchCase.id,
          tier: benchCase.tier,
          score: passed ? 1 : 0,
          latency_ms: Math.round(performance.now() - startedAt),
          cost_usd: result.usage?.cost ?? null,
          detail_json: JSON.stringify({
            finishReason: result.choices[0]?.finishReason ?? null,
            outputPrefix: text.slice(0, 200),
          }),
          error: null,
        });
      } catch (error) {
        await upsertCaseResult(
          env.BENCH_DB,
          failedRow(message, benchCase.id, benchCase.tier, startedAt, error)
        );
      }
    });
  }

  await finalizeRunIfComplete(env, message.runId, message.kind);
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

async function getRunConfig(env: Env, runId: string): Promise<BenchmarkConfig> {
  // Snapshot taken at startRun time so a mid-run admin edit can't skew it.
  const run = await getRun(env.BENCH_DB, runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  return BenchmarkConfigSchema.parse(JSON.parse(run.config_json));
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
  const config = await getRunConfig(env, runId);
  const models =
    kind === 'classifier' ? config.classifierModels : config.deciderModels.map(m => m.id);
  const caseCount = kind === 'classifier' ? CLASSIFIER_CASES.length : DECIDER_CASES.length;
  const expected = models.length * caseCount;
  const actual = await countCaseResults(env.BENCH_DB, runId);

  if (actual < expected) return;

  // Two consumers may both see completion and both aggregate — harmless:
  // identical deterministic inputs → identical summaries; replaceModelSummaries
  // is a batched delete+insert; markRunCompleted guards on status='running';
  // KV put is idempotent.
  const rows = await getCaseResults(env.BENCH_DB, runId);
  const summaries = summarize(rows, kind);
  await replaceModelSummaries(env.BENCH_DB, runId, summaries);
  await markRunCompleted(env.BENCH_DB, runId);

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
        ? Number(
            (costs.reduce((a, r) => a + (r.cost_usd ?? 0), 0) / costs.length).toFixed(8)
          )
        : null,
      avgLatencyMs: Math.round(group.reduce((a, r) => a + r.latency_ms, 0) / group.length),
      p50LatencyMs: latencies[Math.floor(latencies.length / 2)] ?? null,
      cases: group.length,
      errors: group.filter(r => r.error !== null).length,
    };
  });
}
