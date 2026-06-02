export type ContextUsage = {
  contextTokens: number;
  providerID: string;
  modelID: string;
};

type AssistantContextUsageResult =
  | { status: 'ineligible' }
  | { status: 'malformed' }
  | { status: 'usage'; contextUsage: ContextUsage };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function getAssistantContextUsage(info: unknown): AssistantContextUsageResult {
  if (!isRecord(info) || info.role !== 'assistant') return { status: 'ineligible' };
  if (!isRecord(info.tokens)) return { status: 'malformed' };

  const { input, output, reasoning, cache } = info.tokens;
  if (!isFiniteNonNegativeNumber(output)) return { status: 'malformed' };
  if (output === 0) return { status: 'ineligible' };
  if (typeof info.providerID !== 'string' || typeof info.modelID !== 'string') {
    return { status: 'malformed' };
  }
  if (!isFiniteNonNegativeNumber(input)) return { status: 'malformed' };
  if (!isFiniteNonNegativeNumber(reasoning)) return { status: 'malformed' };
  if (!isRecord(cache)) return { status: 'malformed' };
  if (!isFiniteNonNegativeNumber(cache.read) || !isFiniteNonNegativeNumber(cache.write)) {
    return { status: 'malformed' };
  }

  const contextTokens = input + output + reasoning + cache.read + cache.write;
  if (!Number.isFinite(contextTokens)) return { status: 'malformed' };

  return {
    status: 'usage',
    contextUsage: {
      contextTokens,
      providerID: info.providerID,
      modelID: info.modelID,
    },
  };
}

export function findLatestContextUsage(
  messages: readonly { info: unknown }[]
): ContextUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;

    const result = getAssistantContextUsage(message.info);
    if (result.status === 'malformed') return undefined;
    if (result.status === 'usage') return result.contextUsage;
  }

  return undefined;
}

export function calculateContextUsagePercentage(
  contextTokens: number,
  contextWindow: number | undefined
): number | undefined {
  if (!isFiniteNonNegativeNumber(contextTokens)) return undefined;
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }

  const percentage = Math.round((contextTokens / contextWindow) * 100);
  return Number.isFinite(percentage) ? percentage : undefined;
}
