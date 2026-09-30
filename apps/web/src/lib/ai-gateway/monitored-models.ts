import { isKiloAutoModel } from '@/lib/ai-gateway/auto-model';
import { getPreferredModels } from '@/lib/ai-gateway/preferred-models';

export async function getMonitoredModels(): Promise<string[]> {
  return (await getPreferredModels()).filter(model => !isKiloAutoModel(model));
}
