import type { ContextUsage } from '@/lib/cloud-agent-sdk/context-usage';

type ModelContextLength = {
  id: string;
  context_length?: number | null;
};

export function buildContextLengthByModelId(
  models: readonly ModelContextLength[]
): ReadonlyMap<string, number> {
  const contextLengthByModelId = new Map<string, number>();
  const conflictingModelIds = new Set<string>();

  for (const model of models) {
    const contextLength = model.context_length;
    if (contextLength === undefined || contextLength === null) continue;
    if (!Number.isFinite(contextLength) || contextLength <= 0) continue;
    if (conflictingModelIds.has(model.id)) continue;

    const existingContextLength = contextLengthByModelId.get(model.id);
    if (existingContextLength === undefined) {
      contextLengthByModelId.set(model.id, contextLength);
      continue;
    }

    if (existingContextLength !== contextLength) {
      contextLengthByModelId.delete(model.id);
      conflictingModelIds.add(model.id);
    }
  }

  return contextLengthByModelId;
}

export function resolveContextWindow(
  contextUsage: ContextUsage | undefined,
  contextLengthByModelId: ReadonlyMap<string, number>
): number | undefined {
  if (contextUsage?.providerID !== 'kilo') return undefined;

  const contextWindow = contextLengthByModelId.get(contextUsage.modelID);
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }

  return contextWindow;
}
