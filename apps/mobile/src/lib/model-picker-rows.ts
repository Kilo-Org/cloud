import { type ModelOption } from '@/lib/hooks/use-available-models';
import { CLI_MODEL_ID } from 'cloud-agent-sdk/cli-model';

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
  const cliModel = filtered.find(m => m.id === CLI_MODEL_ID);
  const all = filtered.filter(m => !m.isPreferred && m.id !== CLI_MODEL_ID);
  const result: ModelPickerRow[] = [];

  if (cliModel) {
    result.push({ key: `model:${cliModel.id}`, model: cliModel, type: 'model' });
  }

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
