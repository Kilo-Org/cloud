import { ENKRYPT_PUBLICATION_ENABLED } from '@/lib/config.server';
import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import type { ModelStats } from '@kilocode/db/schema';
import {
  ENKRYPT_STALE_AFTER_MS,
  EnkryptBenchmarkSchema,
  type EnkryptPublishedBenchmark,
} from '@kilocode/db/schema-types';

export function publishEnkryptBenchmark(
  value: unknown,
  now = Date.now()
): EnkryptPublishedBenchmark | undefined {
  if (!ENKRYPT_PUBLICATION_ENABLED) return undefined;
  const result = EnkryptBenchmarkSchema.safeParse(value);
  if (!result.success) return undefined;
  const ingestedAt = Date.parse(result.data.ingestedAt);
  if (!Number.isFinite(now) || !Number.isFinite(ingestedAt) || ingestedAt > now) return undefined;
  const staleAfter = ingestedAt + ENKRYPT_STALE_AFTER_MS;
  return {
    ...result.data,
    staleAfter: new Date(staleAfter).toISOString(),
    freshness: now < staleAfter ? 'fresh' : 'stale',
  };
}

type PublicModel = Pick<ModelStats, 'openrouterId' | 'isActive' | 'isStealth'>;

export function isEnkryptPublicModel(model: PublicModel): boolean {
  return (
    model.isActive === true &&
    model.isStealth === false &&
    !model.openrouterId.startsWith(CUSTOM_LLM_PREFIX)
  );
}

export function publishEnkryptModelStats<
  T extends PublicModel & Pick<ModelStats, 'benchmarks' | 'openrouterData'>,
>(stat: T) {
  const openrouterData = { ...stat.openrouterData };
  if ('enkrypt' in openrouterData) delete openrouterData.enkrypt;
  const publishedStat = { ...stat, openrouterData };
  if (!stat.benchmarks) return publishedStat;
  const benchmarks = { ...stat.benchmarks };
  delete benchmarks.enkrypt;
  const enkrypt = isEnkryptPublicModel(stat)
    ? publishEnkryptBenchmark(stat.benchmarks.enkrypt)
    : undefined;
  return { ...publishedStat, benchmarks: { ...benchmarks, ...(enkrypt && { enkrypt }) } };
}
