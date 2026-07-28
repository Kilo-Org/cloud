type SortableRemoteModel = {
  id: string;
  name?: string;
  recommendedIndex?: number;
  isFree?: boolean;
  mayTrainOnYourPrompts?: boolean;
  hasUserByokAvailable?: boolean;
};

type SortableRemoteProvider = {
  id: string;
  name?: string;
  models: readonly SortableRemoteModel[];
};

function providerName(provider: { id: string; name?: string }): string {
  return provider.name ?? provider.id;
}

function modelName(model: SortableRemoteModel): string {
  return model.name ?? model.id;
}

export function getRemoteModelRecommendedRank(
  providerId: string,
  model: SortableRemoteModel
): number {
  if (providerId !== 'kilo') return 0;
  return model.recommendedIndex ?? Number.POSITIVE_INFINITY;
}

export function isRemoteModelRecommended(providerId: string, model: SortableRemoteModel): boolean {
  return Number.isFinite(getRemoteModelRecommendedRank(providerId, model));
}

function hasTuiFooter(providerId: string, model: SortableRemoteModel): boolean {
  return (
    (providerId === 'kilo' &&
      (model.hasUserByokAvailable === true || model.mayTrainOnYourPrompts === true)) ||
    (providerId === 'opencode' && model.isFree === true)
  );
}

function compareProvider(left: SortableRemoteProvider, right: SortableRemoteProvider): number {
  const leftOpenCode = left.id === 'opencode' ? 0 : 1;
  const rightOpenCode = right.id === 'opencode' ? 0 : 1;
  return leftOpenCode - rightOpenCode || providerName(left).localeCompare(providerName(right));
}

function compareModel(
  providerId: string,
  left: SortableRemoteModel,
  right: SortableRemoteModel
): number {
  return (
    getRemoteModelRecommendedRank(providerId, left) -
      getRemoteModelRecommendedRank(providerId, right) ||
    Number(!hasTuiFooter(providerId, left)) - Number(!hasTuiFooter(providerId, right)) ||
    modelName(left).localeCompare(modelName(right))
  );
}

export function sortRemoteModelCatalogProviders<
  TProvider extends { id: string; name?: string; models: readonly SortableRemoteModel[] },
>(
  providers: readonly TProvider[]
): Array<Omit<TProvider, 'models'> & { models: Array<TProvider['models'][number]> }> {
  return providers
    .map(provider => ({
      ...provider,
      models: [...provider.models].sort((left, right) => compareModel(provider.id, left, right)),
    }))
    .sort(compareProvider);
}
