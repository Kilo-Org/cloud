import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import * as z from 'zod';
import {
  BenchmarkModelSummarySchema,
  CandidatePricingSchema,
  ProductionTokenProfileSchema,
} from '@kilocode/auto-routing-contracts';
import { rowsToRoutingTable } from '../src/db';
import { computeEngineIdentity } from '../src/run';
import { pickClassifierWinner } from '../src/winner';
import { BenchmarkModelCatalogSchema, catalogCandidatePrices } from '../src/platform-models';
import { buildScoreboard } from '../src/scoreboard/build';
import { compareScoreboards } from '../src/scoreboard/compare';
import {
  LiveScoreboardCandidateRowSchema,
  LiveScoreboardTableRowSchema,
  OfflineSweepSchema,
  ProdMetricsSchema,
  ReplayMetricsSchema,
  ScoreboardRoutingTableSchema,
  ScoreboardSchema,
} from '../src/scoreboard/schema';

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const classifierRunSchema = z.object({
  id: z.string(),
  min_accuracy: z.number(),
  classifier_max_p95_latency_ms: z.number().nullable(),
});

const pricingCatalogSchema = BenchmarkModelCatalogSchema.transform(catalog =>
  Object.fromEntries(catalogCandidatePrices(catalog))
);
const pricingSchema = z.union([pricingCatalogSchema, z.record(z.string(), CandidatePricingSchema)]);

async function loadPricing(path: string) {
  if (path !== 'live') return readJson(path, pricingSchema);
  const response = await fetch('https://app.kilo.ai/api/openrouter/models');
  if (!response.ok) throw new Error(`Pricing catalog request failed: HTTP ${response.status}`);
  return pricingCatalogSchema.parse(await response.json());
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, 'utf8')));
}

async function queryD1<T>(sql: string, rowSchema: z.ZodType<T>): Promise<T[]> {
  const { stdout } = await execFileAsync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      'auto-routing-benchmark',
      '--remote',
      '--json',
      '--command',
      sql,
    ],
    { cwd: packageDirectory, maxBuffer: 16 * 1024 * 1024 }
  );
  const results = z
    .array(z.object({ success: z.literal(true), results: z.array(rowSchema) }))
    .parse(JSON.parse(stdout));
  return results.flatMap(result => result.results);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function loadLiveTable() {
  const [tableRows, classifierRuns] = await Promise.all([
    queryD1(
      'SELECT * FROM routing_tables ORDER BY published_at DESC LIMIT 1',
      LiveScoreboardTableRowSchema
    ),
    queryD1(
      `SELECT id, min_accuracy, classifier_max_p95_latency_ms FROM benchmark_runs
      WHERE kind = 'classifier' AND status = 'completed'
        AND engine_identity = ${sqlString(computeEngineIdentity('classifier'))}
      ORDER BY completed_at DESC LIMIT 1`,
      classifierRunSchema
    ),
  ]);
  const tableRow = tableRows[0];
  if (!tableRow) throw new Error('No published platform routing table found');
  const classifierRun = classifierRuns[0];
  const [candidateRows, summaries] = await Promise.all([
    queryD1(
      `SELECT c.*, s.p50_latency_ms AS p50LatencyMs
      FROM routing_table_candidates c LEFT JOIN benchmark_profiles p
        ON p.model = c.model AND p.variant = c.variant AND p.status = 'ready'
          AND p.engine_identity = ${sqlString(computeEngineIdentity('decider'))}
          AND p.repetitions = (SELECT decider_repetitions FROM benchmark_config WHERE id = 1)
      LEFT JOIN model_summaries s
        ON s.run_id = p.run_id AND s.model = p.model AND s.variant = p.variant AND s.route_key = c.route_key
      WHERE c.run_id = ${sqlString(tableRow.run_id)} ORDER BY c.route_key, c.rank`,
      LiveScoreboardCandidateRowSchema
    ),
    classifierRun
      ? queryD1(
          `SELECT model, NULLIF(variant, '') AS variant, route_key AS routeKey,
      accuracy, avg_cost_usd AS avgCostUsd, avg_latency_ms AS avgLatencyMs,
      p50_latency_ms AS p50LatencyMs, p95_latency_ms AS p95LatencyMs,
      cases, errors, timeouts, route_accuracy AS routeAccuracy
      FROM model_summaries WHERE run_id = ${sqlString(classifierRun.id)} AND route_key = '*'`,
          BenchmarkModelSummarySchema
        )
      : [],
  ]);
  const assembled = rowsToRoutingTable(tableRow, candidateRows);
  for (const row of candidateRows) {
    const candidate = assembled.routes[row.route_key]?.[row.rank];
    if (candidate) Object.assign(candidate, { p50LatencyMs: row.p50LatencyMs });
  }
  const winner = classifierRun
    ? pickClassifierWinner(
        summaries,
        classifierRun.min_accuracy,
        classifierRun.classifier_max_p95_latency_ms
      )
    : null;
  return {
    table: ScoreboardRoutingTableSchema.parse(assembled),
    classifierRouteAccuracy: winner?.routeAccuracy ?? null,
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'build') {
    const { values, positionals } = parseArgs({
      args,
      options: {
        label: { type: 'string' },
        table: { type: 'string', default: 'live' },
        prod: { type: 'string' },
        replay: { type: 'string' },
        out: { type: 'string' },
        pricing: { type: 'string' },
        'rerank-profile': { type: 'string' },
        'cost-profile': { type: 'string' },
        sweep: { type: 'string' },
        'rebuild-from-sweep': { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    if (!values.label || !values.out || positionals.length > 0) {
      throw new Error(
        'Usage: scoreboard build --label <label> [--table live|file.json] [--pricing live|file.json] [--cost-profile file.json] [--rerank-profile file.json] [--sweep file.json] [--rebuild-from-sweep] [--prod file.json] [--replay file.json] --out file.json'
      );
    }
    const tablePath = values.table ?? 'live';
    const [source, prod, replay, pricing, rerankProfile, costProfile, sweep] = await Promise.all([
      tablePath === 'live'
        ? loadLiveTable()
        : readJson(tablePath, ScoreboardRoutingTableSchema).then(table => ({
            table,
            classifierRouteAccuracy: null,
          })),
      values.prod ? readJson(values.prod, ProdMetricsSchema) : null,
      values.replay ? readJson(values.replay, ReplayMetricsSchema) : null,
      values.pricing ? loadPricing(values.pricing) : null,
      values['rerank-profile']
        ? readJson(values['rerank-profile'], ProductionTokenProfileSchema)
        : null,
      values['cost-profile']
        ? readJson(values['cost-profile'], ProductionTokenProfileSchema)
        : null,
      values.sweep ? readJson(values.sweep, OfflineSweepSchema) : null,
    ]);
    if (pricing) {
      for (const candidates of Object.values(source.table.routes)) {
        for (const candidate of candidates) {
          candidate.pricing = pricing[candidate.model] ?? null;
        }
      }
    }
    const scoreboard = ScoreboardSchema.parse(
      buildScoreboard({
        label: values.label,
        ...source,
        prod,
        replay,
        rerankProfile,
        costProfile,
        sweep,
        rebuildFromSweep: values['rebuild-from-sweep'],
        pricing,
        now: new Date(),
      })
    );
    await writeFile(values.out, `${JSON.stringify(scoreboard, null, 2)}\n`);
    return;
  }
  if (command === 'compare') {
    const { values, positionals } = parseArgs({
      args,
      options: { 'relative-only': { type: 'boolean', default: false } },
      allowPositionals: true,
    });
    const [basePath, headPath] = positionals;
    if (positionals.length !== 2 || !basePath || !headPath) {
      throw new Error('Usage: scoreboard compare <base.json> <head.json> [--relative-only]');
    }
    const [base, head] = await Promise.all([
      readJson(basePath, ScoreboardSchema),
      readJson(headPath, ScoreboardSchema),
    ]);
    console.log(compareScoreboards(base, head, { relativeOnly: values['relative-only'] }));
    return;
  }
  throw new Error('Usage: scoreboard <build|compare> ...');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
