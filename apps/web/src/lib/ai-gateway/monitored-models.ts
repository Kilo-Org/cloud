import { isKiloAutoModel } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { preferredModels } from '@kilocode/web-shared/lib/ai-gateway/models';

export const monitoredModels = preferredModels.filter(model => !isKiloAutoModel(model));
