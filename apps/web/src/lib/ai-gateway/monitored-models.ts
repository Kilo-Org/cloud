import { isKiloAutoModel } from '@/lib/ai-gateway/auto-model';
import { getPreferredModels } from '@/lib/ai-gateway/models';
import { getCurrentModelIds } from '@/lib/ai-gateway/providers/gateway-models-cache';

export async function getMonitoredModels(): Promise<string[]> {
  return getPreferredModels(await getCurrentModelIds()).filter(model => !isKiloAutoModel(model));
}
