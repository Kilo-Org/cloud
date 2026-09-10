import { isKiloAutoModel } from '@/lib/ai-gateway/auto-model';
import { preferredModels } from '@/lib/ai-gateway/models';

export const monitoredModels = preferredModels.filter(model => !isKiloAutoModel(model));
