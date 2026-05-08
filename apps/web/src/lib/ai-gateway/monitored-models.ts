import { AUTO_MODELS, isKiloAutoModel, KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/kilo-auto';
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

  // kilo-auto/free rotates through free models that may be removed at any moment;
  // monitoring it would create noisy alerts, so exclude it.
  const autoModelIds = AUTO_MODELS.filter(m => m.id !== KILO_AUTO_FREE_MODEL.id).map(m => m.id);

  for (const model of autoModelIds) {
    for (const { balance, ...params } of VARIATIONS) {
      const result = await resolveAutoModel(
        { model, ...params },
        Promise.resolve(null),
        Promise.resolve(balance)
      );
      if (result.kind === 'ok') {
        set.add(result.resolved.model);
      }
    }
  }

  for (const model of preferredModels) {
    if (!isKiloAutoModel(model)) {
      set.add(model);
    }
  }

  return [...set];
}
