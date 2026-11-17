import { ENKRYPT_PUBLICATION_ENABLED } from '@kilocode/web-shared/lib/config.server';
import { KILO_AUTO_MODEL_PREFIX } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { isEnkryptPublicModel, publishEnkryptBenchmark } from './enkrypt-publication';
import {
  getModelStatsSnapshot,
  isModelStatsSnapshotFresh,
  type ModelStatsLoadClient,
  type ModelStatsSnapshot,
} from './model-stats-cache';
import type { EnkryptPublishedBenchmark } from '@kilocode/db/schema-types';
import { lookupModelWithKiloGatewayFallback } from './model-id-lookup';

export { ENKRYPT_STALE_AFTER_MS } from '@kilocode/db/schema-types';

export type EnkryptBenchmarks = ModelStatsSnapshot | null;

export function enkryptFor(
  snapshot: EnkryptBenchmarks,
  id: string
): EnkryptPublishedBenchmark | undefined {
  if (
    !ENKRYPT_PUBLICATION_ENABLED ||
    !snapshot ||
    !isModelStatsSnapshotFresh(snapshot) ||
    id.startsWith(KILO_AUTO_MODEL_PREFIX)
  ) {
    return undefined;
  }
  const entry = lookupModelWithKiloGatewayFallback(id, candidate =>
    snapshot.entries.find(({ stat }) => stat.openrouterId === candidate)
  );
  return entry && isEnkryptPublicModel(entry.stat, snapshot.customLlmIds)
    ? publishEnkryptBenchmark(entry.stat.benchmarks?.enkrypt, Date.now(), entry.verification)
    : undefined;
}

export function publishEnkryptModels<T extends { id: string; enkrypt?: unknown }>(
  models: readonly T[],
  snapshot: EnkryptBenchmarks
): (Omit<T, 'enkrypt'> & { enkrypt?: EnkryptPublishedBenchmark })[] {
  return models.map(source => {
    const model = { ...source };
    delete model.enkrypt;
    const enkrypt = enkryptFor(snapshot, model.id);
    return { ...model, ...(enkrypt && { enkrypt }) };
  });
}

export async function getEnkryptBenchmarks(
  options: { fromDb?: ModelStatsLoadClient } = {}
): Promise<EnkryptBenchmarks> {
  if (!ENKRYPT_PUBLICATION_ENABLED) return null;
  return getModelStatsSnapshot(options).catch(() => null);
}
