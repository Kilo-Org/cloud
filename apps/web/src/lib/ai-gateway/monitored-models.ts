import { AUTO_MODELS, isKiloAutoModel } from '@/lib/ai-gateway/kilo-auto';
import type { FeatureValue } from '@/lib/feature-detection';
import { resolveAutoModel } from '@/lib/ai-gateway/kilo-auto/resolution';
import { preferredModels } from '@/lib/ai-gateway/models';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

type AutoModelVariation = {
  modeHeader: string | null;
  featureHeader: FeatureValue | null;
  sessionId: string | null;
  apiKind: GatewayRequest['kind'] | null;
  clientIp: string | null;
  balance: number;
};

// we don't vary apiKind for now because messages/responses use on kilo-auto is currently rare
const VARIATIONS: AutoModelVariation[] = [
  {
    modeHeader: null,
    featureHeader: null,
    sessionId: null,
    apiKind: null,
    clientIp: null,
    balance: 0,
  },
  {
    modeHeader: null,
    featureHeader: null,
    sessionId: null,
    apiKind: null,
    clientIp: null,
    balance: 1,
  },
  {
    modeHeader: 'claw',
    featureHeader: 'kiloclaw',
    sessionId: null,
    apiKind: null,
    clientIp: null,
    balance: 0,
  },
];

export async function getMonitoredModels() {
  const set = new Set<string>();

  const autoModelIds = AUTO_MODELS.map(m => m.id);

  for (const model of autoModelIds) {
    for (const { balance, ...params } of VARIATIONS) {
      const resolved = await resolveAutoModel(
        { model, ...params },
        Promise.resolve(null),
        Promise.resolve(balance)
      );
      set.add(resolved.model);
    }
  }

  for (const model of preferredModels) {
    if (!isKiloAutoModel(model)) {
      set.add(model);
    }
  }

  return [...set];
}
