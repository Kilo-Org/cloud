import {
  AUTO_FREE_FALLBACK_MODEL,
  getConfiguredAutoFreeModels,
} from '@/lib/ai-gateway/auto-model/auto-free-config';
import { buildPreferredModels } from '@/lib/ai-gateway/models';

export async function getPreferredModels(): Promise<string[]> {
  const autoFreeModels = await getConfiguredAutoFreeModels();
  return buildPreferredModels(
    (autoFreeModels ?? [])
      .map(({ model }) => model)
      .filter(model => model !== AUTO_FREE_FALLBACK_MODEL.model)
  );
}
