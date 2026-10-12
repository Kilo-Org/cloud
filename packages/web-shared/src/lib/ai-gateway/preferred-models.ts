import {
  AUTO_FREE_FALLBACK_MODEL,
  getConfiguredAutoFreeModels,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';
import { buildMonitoredModels } from '@kilocode/web-shared/lib/ai-gateway/models';

export async function getMonitoredModels(): Promise<string[]> {
  const autoFreeModels = await getConfiguredAutoFreeModels();
  return buildMonitoredModels(
    (autoFreeModels ?? [])
      .map(({ model }) => model)
      .filter(model => model !== AUTO_FREE_FALLBACK_MODEL.model)
  );
}
