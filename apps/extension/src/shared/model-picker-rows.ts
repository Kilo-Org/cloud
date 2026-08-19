import { CLI_MODEL_ID } from '@kilocode/cloud-agent-sdk';
import type { KiloGatewayModelOption } from './kilo-api-client';

/** Prefix of a picker row projected from a remote CLI's own model catalog. */
export const CLI_CATALOG_ID_PREFIX = 'cli:';

/**
 * Server-side model preferences (favorites, last selected) are keyed by gateway
 * model id. The synthetic "CLI default" row and every CLI-catalog row are not
 * gateway models, so their ids must never reach those endpoints.
 */
export const isGatewayModelId = (id: string): boolean =>
  id !== '' && id !== CLI_MODEL_ID && !id.startsWith(CLI_CATALOG_ID_PREFIX);

/** Id shown to the user: a CLI-catalog row shows the CLI's own provider/model. */
export const modelRowDisplayId = (id: string): string =>
  id.startsWith(CLI_CATALOG_ID_PREFIX) ? id.slice(CLI_CATALOG_ID_PREFIX.length) : id;

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
