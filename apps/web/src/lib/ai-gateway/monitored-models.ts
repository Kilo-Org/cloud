import { AUTO_MODELS, isKiloAutoModel } from '@/lib/kilo-auto';
import type { FeatureValue } from '@/lib/feature-detection';
import { resolveAutoModel } from '@/lib/kilo-auto/resolution';
import { preferredModels } from '@/lib/ai-gateway/models';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

type AutoModelVariation = {
  modeHeader: string | null;
  featureHeader: FeatureValue | null;
  sessionId: string | null;
  apiKind: GatewayRequest['kind'] | null;
  balance: number;
};

// A representative set of variations that covers the major resolution branches:
// - Default routing (no mode/feature, zero balance)
// - Paid balance (affects kilo-auto/small: routes to the non-free Gemma variant)
// - Claw mode with kiloclaw feature (routes balanced→claw model, frontier→Opus)
const VARIATIONS: AutoModelVariation[] = [
  { modeHeader: null, featureHeader: null, sessionId: null, apiKind: null, balance: 0 },
  { modeHeader: null, featureHeader: null, sessionId: null, apiKind: null, balance: 1 },
  { modeHeader: 'claw', featureHeader: 'kiloclaw', sessionId: null, apiKind: null, balance: 0 },
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
