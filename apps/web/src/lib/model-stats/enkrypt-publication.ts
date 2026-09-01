import { ENKRYPT_PUBLICATION_ENABLED } from '@/lib/config.server';
import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import type { ModelStats } from '@kilocode/db/schema';
import {
  ENKRYPT_STALE_AFTER_MS,
  EnkryptBenchmarkSchema,
  EnkryptVerificationSchema,
  type EnkryptPublishedBenchmark,
} from '@kilocode/db/schema-types';
import { fingerprintEnkryptScore } from './enkrypt-fingerprint';

export function publishEnkryptBenchmark(
  value: unknown,
  now = Date.now(),
  verification?: unknown
): EnkryptPublishedBenchmark | undefined {
  if (!ENKRYPT_PUBLICATION_ENABLED) return undefined;
  const result = EnkryptBenchmarkSchema.safeParse(value);
  if (!result.success) return undefined;
  const ingestedAt = Date.parse(result.data.ingestedAt);
  if (!Number.isFinite(now) || !Number.isFinite(ingestedAt) || ingestedAt > now) return undefined;
  const verified = EnkryptVerificationSchema.safeParse(verification);
  let lastCheckedAt = ingestedAt;
  if (verified.success) {
    const checkedAt = Date.parse(verified.data.checkedAt);
    if (
      checkedAt >= ingestedAt &&
      checkedAt <= now &&
      verified.data.scoreHash === fingerprintEnkryptScore(result.data)
    ) {
      lastCheckedAt = checkedAt;
    }
  }
  const staleAfter = lastCheckedAt + ENKRYPT_STALE_AFTER_MS;
  return {
    ...result.data,
    lastCheckedAt: new Date(lastCheckedAt).toISOString(),
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
>(stat: T, verification?: unknown) {
  const openrouterData = { ...stat.openrouterData };
  if ('enkrypt' in openrouterData) delete openrouterData.enkrypt;
  const publishedStat = { ...stat, openrouterData };
  if (!stat.benchmarks) return publishedStat;
  const benchmarks = { ...stat.benchmarks };
  delete benchmarks.enkrypt;
  const enkrypt = isEnkryptPublicModel(stat)
    ? publishEnkryptBenchmark(stat.benchmarks.enkrypt, Date.now(), verification)
    : undefined;
  return { ...publishedStat, benchmarks: { ...benchmarks, ...(enkrypt && { enkrypt }) } };
}
