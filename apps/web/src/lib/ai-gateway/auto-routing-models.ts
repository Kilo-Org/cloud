import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { KILO_AUTO_EFFICIENT_MODEL, KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import { getAutoFreeCandidates } from '@/lib/ai-gateway/auto-model/resolution';
import { isVirtualAutoModelId } from '@kilocode/auto-routing-contracts';
import { getCachedRoutingTable } from '@/lib/ai-gateway/auto-routing-table-cache';

function visibleConcreteModelIds(models: Iterable<string>, availableModelIds: ReadonlySet<string>) {
  return [
    ...new Set([...models].filter(id => availableModelIds.has(id) && !isVirtualAutoModelId(id))),
  ].sort((left, right) => left.localeCompare(right));
}

export async function addAutoRoutingModels(
  models: OpenRouterModelsResponse['data']
): Promise<OpenRouterModelsResponse['data']> {
  const availableModelIds = new Set(models.map(model => model.id));
  if (
    !availableModelIds.has(KILO_AUTO_EFFICIENT_MODEL.id) &&
    !availableModelIds.has(KILO_AUTO_FREE_MODEL.id)
  ) {
    return models;
  }

  const [table, autoFreeCandidates] = await Promise.all([
    getCachedRoutingTable(),
    getAutoFreeCandidates(null).catch(() => []),
  ]);

  const efficientModelIds = visibleConcreteModelIds(
    Object.values(table?.routes ?? {})
      .flat()
      .map(candidate => candidate.model),
    availableModelIds
  );
  const freeModelIds = visibleConcreteModelIds(autoFreeCandidates, availableModelIds);
  const autoRoutingChoices = new Map([
    [KILO_AUTO_EFFICIENT_MODEL.id, efficientModelIds],
    [KILO_AUTO_FREE_MODEL.id, freeModelIds],
  ]);

  return models.map(model => {
    const modelIds = autoRoutingChoices.get(model.id);
    return modelIds?.length ? { ...model, autoRouting: { models: modelIds } } : model;
  });
}
