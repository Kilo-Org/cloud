import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

export type ModelPickerRow =
  | { key: string; title: string; type: 'header' }
  | { key: string; model: SessionModelOption; isFavorite: boolean; type: 'model' };

type ModelGroup = {
  key: string;
  title: string;
  models: SessionModelOption[];
};

export type FavoriteToggleAction =
  | { type: 'add'; model: string }
  | { type: 'remove'; models: string[] };

// A CLI-catalog option is one with a CLI `modelRef` that is not a legacy
// Gateway projection. A Gateway or legacy-gateway option is everything else,
// including an option with no `modelRef`.
function isCliCatalogOption(model: SessionModelOption): boolean {
  return Boolean(model.modelRef) && model.overrideSource !== 'legacy-gateway';
}

// The stable write id. Favorites are persisted server-side by this key, so it
// must be stable across sessions and catalog refreshes. CLI catalog options get
// opaque order-based `id`s (`remote-model-N`), so favorite them by their CLI
// model identity instead. Kilo CLI options share the Gateway model id; other
// providers get a `remote:<provider>:<model>` key. Gateway and legacy-gateway
// options keep `id` — the Gateway model id shared with regular Gateway
// favorites.
export function canonicalFavoriteId(model: SessionModelOption): string {
  const modelRef = isCliCatalogOption(model) ? model.modelRef : undefined;
  if (modelRef) {
    return modelRef.providerID === 'kilo'
      ? modelRef.modelID
      : `remote:${modelRef.providerID}:${modelRef.modelID}`;
  }
  return model.id;
}

// Legacy alias kept for existing callers and tests.
export const modelPickerFavoriteId = canonicalFavoriteId;

// Every stored string that marks this option starred. Gateway options accept
// their Gateway id and the historical `remote:kilo:<id>` alias; kilo CLI options
// accept the same pair; other-provider CLI options accept only their
// `remote:<provider>:<model>` key.
export function favoriteKeysForOption(model: SessionModelOption): string[] {
  const modelRef = isCliCatalogOption(model) ? model.modelRef : undefined;
  if (modelRef) {
    if (modelRef.providerID === 'kilo') {
      return [modelRef.modelID, `remote:kilo:${modelRef.modelID}`];
    }
    return [`remote:${modelRef.providerID}:${modelRef.modelID}`];
  }
  return [model.id, `remote:kilo:${model.id}`];
}

export function isFavoriteOption(
  model: SessionModelOption,
  favoriteIds: ReadonlySet<string>
): boolean {
  return favoriteKeysForOption(model).some(key => favoriteIds.has(key));
}

export function favoriteToggleAction(
  option: SessionModelOption,
  storedFavorites: readonly string[]
): FavoriteToggleAction {
  const stored = new Set(storedFavorites);
  const matching = favoriteKeysForOption(option).filter(key => stored.has(key));
  if (matching.length > 0) {
    return { type: 'remove', models: matching };
  }
  return { type: 'add', model: canonicalFavoriteId(option) };
}

export function buildModelPickerRows({
  models,
  search,
  favoriteIds,
}: {
  models: SessionModelOption[];
  search: string;
  favoriteIds: Set<string>;
}): ModelPickerRow[] {
  const query = search.toLowerCase().trim();
  const filtered = models.filter(model => !query || searchableText(model).includes(query));

  const favorites = filtered.filter(model => isFavoriteOption(model, favoriteIds));
  const rest = filtered.filter(model => !isFavoriteOption(model, favoriteIds));

  const rows: ModelPickerRow[] = [];

  if (favorites.length > 0) {
    rows.push({ key: 'favorites', title: 'FAVORITES', type: 'header' });
    for (const model of favorites) {
      rows.push({ key: `model:${model.id}`, model, isFavorite: true, type: 'model' });
    }
  }

  const groups = new Map<string, ModelGroup>();
  for (const model of rest) {
    const group = groupForModel(model);
    const existing = groups.get(group.key);
    if (existing) {
      existing.models.push(model);
    } else {
      groups.set(group.key, { ...group, models: [model] });
    }
  }

  for (const group of groups.values()) {
    rows.push({ key: group.key, title: group.title, type: 'header' });
    for (const model of group.models) {
      rows.push({ key: `model:${model.id}`, model, isFavorite: false, type: 'model' });
    }
  }

  return rows;
}

function searchableText(model: SessionModelOption): string {
  return [model.name, model.displayId, model.provider?.name, model.provider?.id]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function groupForModel(model: SessionModelOption): Pick<ModelGroup, 'key' | 'title'> {
  if (model.provider) {
    return {
      key: `provider:${model.provider.id}`,
      title: model.provider.name.toUpperCase(),
    };
  }
  if (model.isPreferred) {
    return { key: 'recommended', title: 'RECOMMENDED' };
  }
  return { key: 'all', title: 'ALL MODELS' };
}
