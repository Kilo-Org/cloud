import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

export type ModelPickerRow =
  | { key: string; title: string; type: 'header' }
  | { key: string; model: SessionModelOption; isFavorite: boolean; type: 'model' };

type ModelGroup = {
  key: string;
  title: string;
  models: SessionModelOption[];
};

// Favorites are persisted server-side by this key, so it must be stable
// across sessions and catalog refreshes. CLI catalog options get opaque
// order-based `id`s (`remote-model-N`), so favorite them by their CLI model
// identity instead. Legacy Gateway options keep `id` — it is the Gateway
// model id and already shared with regular Gateway favorites.
export function modelPickerFavoriteId(model: SessionModelOption): string {
  return model.modelRef && model.overrideSource !== 'legacy-gateway'
    ? `remote:${model.modelRef.providerID}:${model.modelRef.modelID}`
    : model.id;
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

  const favorites = filtered.filter(model => favoriteIds.has(modelPickerFavoriteId(model)));
  const rest = filtered.filter(model => !favoriteIds.has(modelPickerFavoriteId(model)));

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
