import { MARTIAN } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/martian';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import type {
  KiloExclusiveModel,
  KiloExclusiveModelProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

const KILO_EXCLUSIVE_MODEL_PROVIDERS = {
  openrouter: OPENROUTER,
  martian: MARTIAN,
  vercel: VERCEL_AI_GATEWAY,
} as const satisfies Record<KiloExclusiveModelProviderId, Provider>;

export function getKiloExclusiveModelProvider(model: KiloExclusiveModel): Provider {
  return KILO_EXCLUSIVE_MODEL_PROVIDERS[model.provider];
}
