import { CUSTOM_LLM_PREFIX } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { ModelStatsBenchmarksSchema, modelStats } from '@kilocode/db/schema';
import { unprefixKiloGatewayModelId } from '@kilocode/worker-utils/kilo-model-id';
import { and, eq, notLike } from 'drizzle-orm';

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

function parseEvals(row: Row): KiloBenchEvals | undefined {
  if (!row.isActive || row.openrouterId.startsWith(CUSTOM_LLM_PREFIX)) return undefined;
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

export function summarizeTerminalBench(
  rows: readonly Row[],
  taskSource: string = LEGACY_TASK_SOURCE
): TerminalBenchSummaries {
  const summaries = new Map<string, TerminalBenchSummary>();

  for (const row of rows) {
    const summary = eligibleSummary(parseEvals(row)?.[taskSource]);
    if (summary) summaries.set(row.openrouterId, summary);
  }

  return summaries;
}

/**
 * Per model, the eligible `terminal-bench/terminal-bench@<n>` eval with the highest numeric
 * Hub revision. Legacy `terminal-bench` is never considered.
 */
export function summarizeTerminalBenchLatest(rows: readonly Row[]): TerminalBenchLatestSummaries {
  const summaries = new Map<string, TerminalBenchLatestSummary>();

  for (const row of rows) {
    const evals = parseEvals(row);
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

function loadTerminalBenchRows(): Promise<Row[]> {
  return readDb
    .select({
      openrouterId: modelStats.openrouterId,
      isActive: modelStats.isActive,
      benchmarks: modelStats.benchmarks,
    })
    .from(modelStats)
    .where(
      and(eq(modelStats.isActive, true), notLike(modelStats.openrouterId, `${CUSTOM_LLM_PREFIX}%`))
    );
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

export const getTerminalBenchSummaries = createTerminalBenchFetch(async () =>
  summarizeTerminalBench(await loadTerminalBenchRows())
);

export const getTerminalBenchLatestSummaries = createTerminalBenchFetch(async () =>
  summarizeTerminalBenchLatest(await loadTerminalBenchRows())
);
