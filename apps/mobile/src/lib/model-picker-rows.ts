import { type ModelOption } from '@/lib/hooks/use-available-models';

export type ModelPickerRow =
  | { key: string; title: string; type: 'header' }
  | { key: string; model: ModelOption; type: 'model' };

export function buildModelPickerRows({
  models,
  search,
}: {
  models: ModelOption[];
  search: string;
}): ModelPickerRow[] {
  const query = search.toLowerCase().trim();
  const filtered = models.filter(
    m => !query || m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query)
  );

  const recommended = filtered.filter(m => m.isPreferred);
  const all = filtered.filter(m => !m.isPreferred);
  const result: ModelPickerRow[] = [];

  if (recommended.length > 0) {
    result.push({ key: 'recommended', title: 'RECOMMENDED', type: 'header' });
    for (const modelOption of recommended) {
      result.push({ key: `model:${modelOption.id}`, model: modelOption, type: 'model' });
    }
  }
  if (all.length > 0) {
    result.push({ key: 'all', title: 'ALL MODELS', type: 'header' });
    for (const modelOption of all) {
      result.push({ key: `model:${modelOption.id}`, model: modelOption, type: 'model' });
    }
  }
  return result;
}
