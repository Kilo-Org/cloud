import { isKiloAutoModel } from '@/lib/kilo-auto';
import { resolveAutoModel } from '@/lib/kilo-auto/resolution';
import { preferredModels } from '@/lib/models';

// Models excluded from the health check but still preferred/recommended.
// Useful for preview models with inconsistent traffic that cause false alerts.
const healthCheckExclusions = new Set(['google/gemini-3.1-pro-preview']);

export async function getMonitoredModels() {
  const set = new Set<string>();
  for (const model of preferredModels) {
    if (healthCheckExclusions.has(model)) {
      continue;
    }
    if (isKiloAutoModel(model)) {
      set.add(
        (await resolveAutoModel(model, null, Promise.resolve(null), Promise.resolve(0))).model
      );
    } else {
      set.add(model);
    }
  }
  return [...set];
}
