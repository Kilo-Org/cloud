import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import { ENKRYPT_PUBLICATION_ENABLED } from '@/lib/config.server';
import { isEnkryptPublicModel, publishEnkryptBenchmark } from './enkrypt-publication';
import { createCachedFetch } from '@/lib/cached-fetch';
import { readDb } from '@/lib/drizzle';
import { ModelStatsBenchmarksSchema, modelStats } from '@kilocode/db/schema';
import type { EnkryptBenchmark, EnkryptPublishedBenchmark } from '@kilocode/db/schema-types';
import { unprefixKiloGatewayModelId } from '@kilocode/worker-utils/kilo-model-id';
import { and, eq, notLike } from 'drizzle-orm';

export { ENKRYPT_STALE_AFTER_MS } from '@kilocode/db/schema-types';

const EnkryptNamespaceSchema = ModelStatsBenchmarksSchema.unwrap()
  .pick({ enkrypt: true })
  .optional();

const TTL = 5 * 60 * 1000;

export type EnkryptBenchmarks = ReadonlyMap<string, EnkryptBenchmark>;

type Row = {
  openrouterId: string;
  isActive: boolean | null;
  isStealth: boolean;
  benchmarks: unknown;
};

export function summarizeEnkrypt(rows: readonly Row[]): EnkryptBenchmarks {
  const benchmarks = new Map<string, EnkryptBenchmark>();

  for (const row of rows) {
    if (!isEnkryptPublicModel(row)) continue;
    const result = EnkryptNamespaceSchema.safeParse(row.benchmarks);
    if (!result.success || !result.data?.enkrypt) continue;
    benchmarks.set(row.openrouterId, result.data.enkrypt);
  }

  return benchmarks;
}

export function enkryptFor(
  benchmarks: EnkryptBenchmarks,
  id: string
): EnkryptPublishedBenchmark | undefined {
  if (!ENKRYPT_PUBLICATION_ENABLED) return undefined;
  const exact = benchmarks.get(id);
  if (exact) return publishEnkryptBenchmark(exact);
  const unprefixed = unprefixKiloGatewayModelId(id);
  return unprefixed ? publishEnkryptBenchmark(benchmarks.get(unprefixed)) : undefined;
}

async function loadEnkrypt(): Promise<EnkryptBenchmarks> {
  const rows = await readDb
    .select({
      openrouterId: modelStats.openrouterId,
      isActive: modelStats.isActive,
      isStealth: modelStats.isStealth,
      benchmarks: modelStats.benchmarks,
    })
    .from(modelStats)
    .where(
      and(
        eq(modelStats.isActive, true),
        eq(modelStats.isStealth, false),
        notLike(modelStats.openrouterId, `${CUSTOM_LLM_PREFIX}%`)
      )
    );
  return summarizeEnkrypt(rows);
}

const getCachedEnkryptBenchmarks = createCachedFetch(
  () =>
    loadEnkrypt().catch(err => {
      console.error('[enkrypt] Failed to load model benchmarks');
      throw err;
    }),
  TTL,
  new Map<string, EnkryptBenchmark>()
);

export async function getEnkryptBenchmarks(): Promise<EnkryptBenchmarks> {
  if (!ENKRYPT_PUBLICATION_ENABLED) return new Map();
  return getCachedEnkryptBenchmarks();
}
