import { requireCustomLlmsById } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { ModelStatsBenchmarksSchema, modelStats } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { lookupModelWithKiloGatewayFallback } from './model-id-lookup';

const TerminalBenchSchema = ModelStatsBenchmarksSchema.unwrap()
  .pick({ kiloBench: true })
  .optional();

const TTL_MS = 5 * 60 * 1000;

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

/** `customLlmIds` holds lowercased custom LLM ids, whose results are never published. */
export function summarizeTerminalBench(
  rows: readonly Row[],
  customLlmIds: ReadonlySet<string>
): TerminalBenchSummaries {
  const summaries = new Map<string, TerminalBenchSummary>();

  for (const row of rows) {
    if (!row.isActive || customLlmIds.has(row.openrouterId.toLowerCase())) continue;
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
  return lookupModelWithKiloGatewayFallback(id, candidate => summaries.get(candidate));
}

async function loadTerminalBench(): Promise<TerminalBenchSummaries> {
  const [rows, customLlmsById] = await Promise.all([loadActiveRows(), requireCustomLlmsById()]);
  return summarizeTerminalBench(rows, new Set(customLlmsById.keys()));
}

async function loadActiveRows(): Promise<Row[]> {
  return await readDb
    .select({
      openrouterId: modelStats.openrouterId,
      isActive: modelStats.isActive,
      benchmarks: modelStats.benchmarks,
    })
    .from(modelStats)
    .where(eq(modelStats.isActive, true));
}

export const getTerminalBenchSummaries = createCachedFetch(
  loadTerminalBench,
  TTL_MS,
  new Map<string, TerminalBenchSummary>(),
  { name: 'terminalBenchSummaries' }
);
