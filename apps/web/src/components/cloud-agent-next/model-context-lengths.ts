import {
  createContextLengthIndex,
  recordContextLength,
  type ContextLengthIndex,
  type ContextUsage,
} from '@kilocode/cloud-agent-sdk/context-usage';

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

export function buildContextLengthByModelId(
  models: readonly ModelContextLength[]
): ReadonlyMap<string, number> {
  const index = createContextLengthIndex();

  for (const model of models) {
    const contextLength = model.context_length;
    if (contextLength === undefined || contextLength === null) continue;
    recordContextLength(index, model.id, contextLength);
  }

  return index.lengths;
}

export function buildContextLengthByProviderAndModel(
  providers: readonly ProviderModelContextLength[]
): ContextLengthByProviderAndModel {
  const indexByProvider = new Map<string, ContextLengthIndex>();
  const lengths = new Map<string, ReadonlyMap<string, number>>();

  for (const provider of providers) {
    let index = indexByProvider.get(provider.id);
    if (!index) {
      index = createContextLengthIndex();
      indexByProvider.set(provider.id, index);
    }

    for (const model of provider.models) {
      recordContextLength(index, model.id, model.limits.context);
    }

    lengths.set(provider.id, index.lengths);
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
