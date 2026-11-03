import type { DirectByokModel } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

function normalizedUpstreamId(model: DirectByokModel) {
  return model.id.toLowerCase().replace(/^hf:/, '');
}

function namesCatalogModel(model: DirectByokModel, catalogModelId: string) {
  const lastSegment = catalogModelId.slice(catalogModelId.lastIndexOf('/') + 1);
  return normalizedUpstreamId(model).endsWith(lastSegment);
}

function isPreferredPrimary(
  candidate: DirectByokModel,
  current: DirectByokModel,
  catalogModelId: string
) {
  const candidateNamed = namesCatalogModel(candidate, catalogModelId);
  if (candidateNamed !== namesCatalogModel(current, catalogModelId)) return candidateNamed;
  const candidateRecommended = candidate.flags?.includes('recommended') ?? false;
  if (candidateRecommended !== (current.flags?.includes('recommended') ?? false)) {
    return candidateRecommended;
  }
  return candidate.id.length < current.id.length;
}

/**
 * Several upstream models of one provider can share a catalog id, such as serving-tier variants
 * (`kimi-k3`, `kimi-k3-fast`). Only one, the primary, is served under the catalog id: the model
 * whose upstream id names the catalog model, then a recommended one, then the shortest id.
 */
export function selectPrimaryCatalogModels(
  models: ReadonlyArray<DirectByokModel>
): ReadonlyMap<string, DirectByokModel> {
  const primaries = new Map<string, DirectByokModel>();
  for (const model of models) {
    const catalogModelId = model.catalog_model_id;
    if (!catalogModelId) continue;
    const current = primaries.get(catalogModelId);
    if (!current || isPreferredPrimary(model, current, catalogModelId)) {
      primaries.set(catalogModelId, model);
    }
  }
  return primaries;
}

// Provider model lists are cached arrays, so the derived map lives as long as the cached list.
const primaryCatalogModelsByList = new WeakMap<
  ReadonlyArray<DirectByokModel>,
  ReadonlyMap<string, DirectByokModel>
>();

export function getPrimaryCatalogModels(
  models: ReadonlyArray<DirectByokModel>
): ReadonlyMap<string, DirectByokModel> {
  let primaries = primaryCatalogModelsByList.get(models);
  if (!primaries) {
    primaries = selectPrimaryCatalogModels(models);
    primaryCatalogModelsByList.set(models, primaries);
  }
  return primaries;
}
