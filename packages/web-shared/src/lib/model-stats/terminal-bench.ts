import { requireCustomLlmsById } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { ModelStatsBenchmarksSchema, modelStats } from '@kilocode/db/schema';
import { unprefixKiloGatewayModelId } from '@kilocode/worker-utils/kilo-model-id';
import { eq } from 'drizzle-orm';

const TerminalBenchSchema = ModelStatsBenchmarksSchema.unwrap()
  .pick({ kiloBench: true })
  .optional();

const TTL = process.env.NODE_ENV === 'test' ? 0 : 5 * 60 * 1000;

export type TerminalBenchSummary = {
  overallScore: number;
  avgAttemptCostUsd: number;
};

export type TerminalBenchSummaries = ReadonlyMap<string, TerminalBenchSummary>;

export type TerminalBenchLatestSummary = TerminalBenchSummary & {
  release: string | null;
  revision: string;
  scope: string | null;
};

export type TerminalBenchLatestSummaries = ReadonlyMap<string, TerminalBenchLatestSummary>;

const LEGACY_TASK_SOURCE = 'terminal-bench';
const REVISIONED_EVAL_KEY = /^terminal-bench\/terminal-bench@(\d+)$/;
const MIN_ATTEMPTS = 5;

type Row = {
  openrouterId: string;
  isActive: boolean | null;
  benchmarks: unknown;
};

type KiloBenchEvals = NonNullable<
  NonNullable<NonNullable<typeof TerminalBenchSchema._output>['kiloBench']>
>['evals'];
type KiloBenchEval = KiloBenchEvals[string];

function parseEvals(row: Row, customLlmIds: ReadonlySet<string>): KiloBenchEvals | undefined {
  if (!row.isActive || customLlmIds.has(row.openrouterId.toLowerCase())) return undefined;
  const result = TerminalBenchSchema.safeParse(row.benchmarks);
  return result.success ? result.data?.kiloBench?.evals : undefined;
}

function eligibleSummary(bench: KiloBenchEval | undefined): TerminalBenchSummary | undefined {
  if (
    !bench ||
    (bench.nAttempts ?? 0) < MIN_ATTEMPTS ||
    bench.avgAttemptCostUsd === null ||
    bench.avgAttemptCostUsd === undefined
  ) {
    return undefined;
  }
  return { overallScore: bench.overallScore, avgAttemptCostUsd: bench.avgAttemptCostUsd };
}

/** `customLlmIds` holds lowercased custom LLM ids, whose results are never published. */
export function summarizeTerminalBench(
  rows: readonly Row[],
  customLlmIds: ReadonlySet<string>,
  taskSource: string = LEGACY_TASK_SOURCE
): TerminalBenchSummaries {
  const summaries = new Map<string, TerminalBenchSummary>();

  for (const row of rows) {
    const summary = eligibleSummary(parseEvals(row, customLlmIds)?.[taskSource]);
    if (summary) summaries.set(row.openrouterId, summary);
  }

  return summaries;
}

/**
 * Per model, the eligible `terminal-bench/terminal-bench@<n>` eval with the highest numeric
 * Hub revision. Legacy `terminal-bench` is never considered.
 */
export function summarizeTerminalBenchLatest(
  rows: readonly Row[],
  customLlmIds: ReadonlySet<string>
): TerminalBenchLatestSummaries {
  const summaries = new Map<string, TerminalBenchLatestSummary>();

  for (const row of rows) {
    const evals = parseEvals(row, customLlmIds);
    if (!evals) continue;
    let best: { revision: number; summary: TerminalBenchLatestSummary } | undefined;
    for (const [key, bench] of Object.entries(evals)) {
      const match = REVISIONED_EVAL_KEY.exec(key);
      if (!match) continue;
      const revision = Number(match[1]);
      if (best && revision <= best.revision) continue;
      const summary = eligibleSummary(bench);
      if (!summary) continue;
      best = {
        revision,
        summary: {
          ...summary,
          release: bench.benchmarkRelease ?? null,
          revision: match[1],
          scope: bench.scope ?? null,
        },
      };
    }
    if (best) summaries.set(row.openrouterId, best.summary);
  }

  return summaries;
}

export function terminalBenchFor<T>(summaries: ReadonlyMap<string, T>, id: string): T | undefined {
  const exact = summaries.get(id);
  if (exact) return exact;
  const unprefixed = unprefixKiloGatewayModelId(id);
  return unprefixed ? summaries.get(unprefixed) : undefined;
}

async function loadActiveRows(): Promise<{ rows: Row[]; customLlmIds: Set<string> }> {
  const [rows, customLlmsById] = await Promise.all([loadRows(), requireCustomLlmsById()]);
  return { rows, customLlmIds: new Set(customLlmsById.keys()) };
}

async function loadRows(): Promise<Row[]> {
  return await readDb
    .select({
      openrouterId: modelStats.openrouterId,
      isActive: modelStats.isActive,
      benchmarks: modelStats.benchmarks,
    })
    .from(modelStats)
    .where(eq(modelStats.isActive, true));
}

function createTerminalBenchFetch<T>(load: () => Promise<ReadonlyMap<string, T>>) {
  return createCachedFetch(
    () =>
      load().catch(err => {
        console.error('[terminal-bench] Failed to load model summaries:', err);
        throw err;
      }),
    TTL,
    new Map<string, T>() as ReadonlyMap<string, T>
  );
}

export const getTerminalBenchSummaries = createTerminalBenchFetch(async () => {
  const { rows, customLlmIds } = await loadActiveRows();
  return summarizeTerminalBench(rows, customLlmIds);
});

export const getTerminalBenchLatestSummaries = createTerminalBenchFetch(async () => {
  const { rows, customLlmIds } = await loadActiveRows();
  return summarizeTerminalBenchLatest(rows, customLlmIds);
});
