import {
  AUTO_FREE_FALLBACK_MODEL,
  getConfiguredAutoFreeModels,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';
import {
  buildMonitoredModels,
  buildPreferredModels,
} from '@kilocode/web-shared/lib/ai-gateway/models';

async function getPreferredFreeModels(): Promise<string[]> {
  const autoFreeModels = await getConfiguredAutoFreeModels();
  return (autoFreeModels ?? [])
    .map(({ model }) => model)
    .filter(model => model !== AUTO_FREE_FALLBACK_MODEL.model);
}

export async function getPreferredModels(): Promise<string[]> {
  return buildPreferredModels(await getPreferredFreeModels());
}

export async function getMonitoredModels(): Promise<string[]> {
  return buildMonitoredModels(await getPreferredFreeModels());
}
