import { ENKRYPT_PUBLICATION_ENABLED } from '@/lib/config.server';
import { KILO_AUTO_MODEL_PREFIX } from '@/lib/ai-gateway/model-utils';
import { isEnkryptPublicModel, publishEnkryptBenchmark } from './enkrypt-publication';
import {
  getModelStatsSnapshot,
  isModelStatsSnapshotFresh,
  type ModelStatsSnapshot,
} from './model-stats-cache';
import type { EnkryptPublishedBenchmark } from '@kilocode/db/schema-types';
import { unprefixKiloGatewayModelId } from '@kilocode/worker-utils/kilo-model-id';

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
  const unprefixed = unprefixKiloGatewayModelId(id);
  const entry =
    snapshot.entries.find(({ stat }) => stat.openrouterId === id) ??
    (unprefixed && snapshot.entries.find(({ stat }) => stat.openrouterId === unprefixed));
  return entry && isEnkryptPublicModel(entry.stat)
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

export async function getEnkryptBenchmarks(): Promise<EnkryptBenchmarks> {
  if (!ENKRYPT_PUBLICATION_ENABLED) return null;
  return getModelStatsSnapshot().catch(() => null);
}
