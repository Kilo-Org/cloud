import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import { createCachedFetch } from '@/lib/cached-fetch';
import { readDb } from '@/lib/drizzle';
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

type Row = {
  openrouterId: string;
  isActive: boolean | null;
  benchmarks: unknown;
};

export function summarizeTerminalBench(rows: readonly Row[]): TerminalBenchSummaries {
  const summaries = new Map<string, TerminalBenchSummary>();

  for (const row of rows) {
    if (!row.isActive || row.openrouterId.startsWith(CUSTOM_LLM_PREFIX)) continue;
    const result = TerminalBenchSchema.safeParse(row.benchmarks);
    if (!result.success) continue;
    const bench = result.data?.kiloBench?.evals['terminal-bench'];
    if (
      !bench ||
      (bench.nAttempts ?? 0) < 5 ||
      bench.avgAttemptCostUsd === null ||
      bench.avgAttemptCostUsd === undefined
    ) {
      continue;
    }
    summaries.set(row.openrouterId, {
      overallScore: bench.overallScore,
      avgAttemptCostUsd: bench.avgAttemptCostUsd,
    });
  }

  return summaries;
}

export function terminalBenchFor(
  summaries: TerminalBenchSummaries,
  id: string
): TerminalBenchSummary | undefined {
  const exact = summaries.get(id);
  if (exact) return exact;
  const unprefixed = unprefixKiloGatewayModelId(id);
  return unprefixed ? summaries.get(unprefixed) : undefined;
}

async function loadTerminalBench(): Promise<TerminalBenchSummaries> {
  const rows = await readDb
    .select({
      openrouterId: modelStats.openrouterId,
      isActive: modelStats.isActive,
      benchmarks: modelStats.benchmarks,
    })
    .from(modelStats)
    .where(
      and(eq(modelStats.isActive, true), notLike(modelStats.openrouterId, `${CUSTOM_LLM_PREFIX}%`))
    );
  return summarizeTerminalBench(rows);
}

function createTerminalBenchFetch(load = loadTerminalBench) {
  return createCachedFetch(
    () =>
      load().catch(err => {
        console.error('[terminal-bench] Failed to load model summaries:', err);
        throw err;
      }),
    TTL,
    new Map<string, TerminalBenchSummary>()
  );
}

export const getTerminalBenchSummaries = createTerminalBenchFetch();
