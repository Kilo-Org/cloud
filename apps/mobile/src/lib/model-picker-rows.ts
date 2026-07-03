import { type ModelOption } from '@/lib/hooks/use-available-models';
import { CLI_MODEL_ID } from 'cloud-agent-sdk/cli-model';

export type ModelPickerRow =
  | { key: string; title: string; type: 'header' }
  | { key: string; model: ModelOption; isFavorite: boolean; type: 'model' };

export function buildModelPickerRows({
  models,
  search,
  favoriteIds,
}: {
  models: ModelOption[];
  search: string;
  favoriteIds: Set<string>;
}): ModelPickerRow[] {
  const query = search.toLowerCase().trim();
  const filtered = models.filter(
    m => !query || m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query)
  );

  const cliModel = filtered.find(m => m.id === CLI_MODEL_ID);
  const rest = filtered.filter(m => m.id !== CLI_MODEL_ID);
  const favorites = rest.filter(m => favoriteIds.has(m.id));
  const recommended = rest.filter(m => !favoriteIds.has(m.id) && m.isPreferred);
  const all = rest.filter(m => !favoriteIds.has(m.id) && !m.isPreferred);
  const result: ModelPickerRow[] = [];

  if (cliModel) {
    result.push({ key: `model:${cliModel.id}`, model: cliModel, isFavorite: false, type: 'model' });
  }

  if (favorites.length > 0) {
    result.push({ key: 'favorites', title: 'FAVORITES', type: 'header' });
    for (const modelOption of favorites) {
      result.push({
        key: `model:${modelOption.id}`,
        model: modelOption,
        isFavorite: true,
        type: 'model',
      });
    }
  }
  if (recommended.length > 0) {
    result.push({ key: 'recommended', title: 'RECOMMENDED', type: 'header' });
    for (const modelOption of recommended) {
      result.push({
        key: `model:${modelOption.id}`,
        model: modelOption,
        isFavorite: false,
        type: 'model',
      });
    }
  }
  if (all.length > 0) {
    result.push({ key: 'all', title: 'ALL MODELS', type: 'header' });
    for (const modelOption of all) {
      result.push({
        key: `model:${modelOption.id}`,
        model: modelOption,
        isFavorite: false,
        type: 'model',
      });
    }
  }
  return result;
}
