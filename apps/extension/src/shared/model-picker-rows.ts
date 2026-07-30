import type { KiloGatewayModelOption } from './kilo-api-client';

export type ExtensionModelPickerRow =
  | { key: string; title: string; type: 'header' }
  | { isFavorite: boolean; key: string; model: KiloGatewayModelOption; type: 'model' };

const matchesSearch = (model: KiloGatewayModelOption, query: string): boolean => {
  if (query.length === 0) {
    return true;
  }

  return model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query);
};

export const buildExtensionModelPickerRows = ({
  favoriteIds,
  models,
  search,
}: {
  readonly favoriteIds: ReadonlySet<string>;
  readonly models: readonly KiloGatewayModelOption[];
  readonly search: string;
}): ExtensionModelPickerRow[] => {
  const query = search.toLowerCase().trim();
  const filtered = models.filter(model => matchesSearch(model, query));

  const favorites = filtered.filter(model => favoriteIds.has(model.id));
  const rest = filtered.filter(model => !favoriteIds.has(model.id));
  const recommended = rest.filter(model => model.isPreferred);
  const allModels = rest.filter(model => !model.isPreferred);

  const rows: ExtensionModelPickerRow[] = [];

  if (favorites.length > 0) {
    rows.push({ key: 'favorites', title: 'FAVORITES', type: 'header' });
    for (const model of favorites) {
      rows.push({ isFavorite: true, key: `model:${model.id}`, model, type: 'model' });
    }
  }

  if (recommended.length > 0) {
    rows.push({ key: 'recommended', title: 'RECOMMENDED', type: 'header' });
    for (const model of recommended) {
      rows.push({ isFavorite: false, key: `model:${model.id}`, model, type: 'model' });
    }
  }

  if (allModels.length > 0) {
    rows.push({ key: 'all', title: 'ALL MODELS', type: 'header' });
    for (const model of allModels) {
      rows.push({ isFavorite: false, key: `model:${model.id}`, model, type: 'model' });
    }
  }

  return rows;
};
