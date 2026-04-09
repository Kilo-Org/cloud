import { isKiloAutoModel } from '@/lib/kilo-auto';
import { resolveAutoModel } from '@/lib/kilo-auto/resolution';
import { preferredModels } from '@/lib/models';

export async function getMonitoredModels() {
  const set = new Set<string>();
  for (const model of preferredModels) {
    if (isKiloAutoModel(model)) {
      set.add(
        (await resolveAutoModel(model, null, Promise.resolve(null), Promise.resolve(0), false))
          .model
      );
    } else {
      set.add(model);
    }
  }
  return [...set];
}
