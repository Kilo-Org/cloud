import type { ContextUsage } from '@/lib/cloud-agent-sdk/context-usage';

type ModelContextLength = {
  id: string;
  context_length?: number | null;
};

type ProviderModelContextLength = {
  id: string;
  models: readonly {
    id: string;
    limits: { context: number };
  }[];
};

export type ContextLengthByProviderAndModel = ReadonlyMap<string, ReadonlyMap<string, number>>;

// First positive value wins; a later conflicting value blacklists the id so a
// model with inconsistent context lengths is treated as unknown rather than
// resolving to an arbitrary one.
function recordUniqueContextLength(
  lengths: Map<string, number>,
  conflicts: Set<string>,
  id: string,
  contextLength: number
): void {
  if (!Number.isFinite(contextLength) || contextLength <= 0) return;
  if (conflicts.has(id)) return;

  const existingContextLength = lengths.get(id);
  if (existingContextLength === undefined) {
    lengths.set(id, contextLength);
  } else if (existingContextLength !== contextLength) {
    lengths.delete(id);
    conflicts.add(id);
  }
}

export function buildContextLengthByModelId(
  models: readonly ModelContextLength[]
): ReadonlyMap<string, number> {
  const contextLengthByModelId = new Map<string, number>();
  const conflictingModelIds = new Set<string>();

  for (const model of models) {
    const contextLength = model.context_length;
    if (contextLength === undefined || contextLength === null) continue;
    recordUniqueContextLength(contextLengthByModelId, conflictingModelIds, model.id, contextLength);
  }

  return contextLengthByModelId;
}

export function buildContextLengthByProviderAndModel(
  providers: readonly ProviderModelContextLength[]
): ContextLengthByProviderAndModel {
  const lengths = new Map<string, Map<string, number>>();
  const conflicts = new Map<string, Set<string>>();

  for (const provider of providers) {
    let providerLengths = lengths.get(provider.id);
    if (!providerLengths) {
      providerLengths = new Map();
      lengths.set(provider.id, providerLengths);
    }
    let providerConflicts = conflicts.get(provider.id);
    if (!providerConflicts) {
      providerConflicts = new Set();
      conflicts.set(provider.id, providerConflicts);
    }

    for (const model of provider.models) {
      recordUniqueContextLength(providerLengths, providerConflicts, model.id, model.limits.context);
    }
  }

  return lengths;
}

export function resolveContextWindow(
  contextUsage: ContextUsage | undefined,
  contextLengthByModelId: ReadonlyMap<string, number>,
  contextLengthByProviderAndModel?: ContextLengthByProviderAndModel
): number | undefined {
  if (!contextUsage) return undefined;

  const contextWindow = contextLengthByProviderAndModel
    ? contextLengthByProviderAndModel.get(contextUsage.providerID)?.get(contextUsage.modelID)
    : contextUsage.providerID === 'kilo'
      ? contextLengthByModelId.get(contextUsage.modelID)
      : undefined;
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }

  return contextWindow;
}
