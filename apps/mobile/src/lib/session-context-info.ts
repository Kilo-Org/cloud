import { calculateContextUsagePercentage, type ContextUsage } from 'cloud-agent-sdk/context-usage';

import { type SessionModelOption } from './hooks/use-session-model-options';

export type SessionContextInfo = {
  contextTokens: number;
  providerID: string;
  modelID: string;
  contextWindow: number | undefined;
  percentage: number | undefined;
};

// Pure resolver for the runtime context window. Matches the Cloud Agent
// Gateway catalog only when the response reports `providerID === 'kilo'` and
// resolves a remote CLI response by exact provider+model identity. Conflicting
// duplicate exact identities are blacklisted so callers never see an arbitrary
// guess.
export function resolveSessionContextInfo(
  contextUsage: ContextUsage | undefined,
  options: readonly SessionModelOption[]
): SessionContextInfo | undefined {
  if (!contextUsage) {
    return undefined;
  }

  const contextWindow = resolveContextWindow(contextUsage, options);
  const percentage = calculateContextUsagePercentage(contextUsage.contextTokens, contextWindow);

  return {
    contextTokens: contextUsage.contextTokens,
    providerID: contextUsage.providerID,
    modelID: contextUsage.modelID,
    contextWindow,
    percentage,
  };
}

type ContextLengthIndex = {
  lengths: Map<string, number>;
  conflicts: Set<string>;
};

function createContextLengthIndex(): ContextLengthIndex {
  return { lengths: new Map(), conflicts: new Set() };
}

function isRecordable(option: SessionModelOption): option is SessionModelOption & {
  contextWindow: number;
} {
  if (option.unavailable) {
    return false;
  }
  if (option.contextWindow === undefined) {
    return false;
  }
  if (!isFinitePositive(option.contextWindow)) {
    return false;
  }
  return true;
}

function resolveContextWindow(
  contextUsage: ContextUsage,
  options: readonly SessionModelOption[]
): number | undefined {
  const kiloIndex = createContextLengthIndex();
  const remoteIndices = new Map<string, ContextLengthIndex>();

  for (const option of options.filter(candidate => isRecordable(candidate))) {
    const providerID = option.modelRef?.providerID ?? (option.showGatewayMetadata ? 'kilo' : null);
    const modelID = option.modelRef?.modelID ?? (option.showGatewayMetadata ? option.id : null);
    if (providerID && modelID && providerID === 'kilo') {
      recordContextLength(kiloIndex, modelID, option.contextWindow);
    } else if (providerID && modelID) {
      let index = remoteIndices.get(providerID);
      if (!index) {
        index = createContextLengthIndex();
        remoteIndices.set(providerID, index);
      }
      recordContextLength(index, modelID, option.contextWindow);
    }
  }

  if (contextUsage.providerID === 'kilo') {
    return takeLength(kiloIndex, contextUsage.modelID);
  }
  const remoteIndex = remoteIndices.get(contextUsage.providerID);
  if (!remoteIndex) {
    return undefined;
  }
  return takeLength(remoteIndex, contextUsage.modelID);
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

// First positive value wins. A later conflicting value permanently removes
// the identity so we never return an arbitrary guess.
function recordContextLength(index: ContextLengthIndex, id: string, value: number): void {
  if (index.conflicts.has(id)) {
    return;
  }
  const existing = index.lengths.get(id);
  if (existing === undefined) {
    index.lengths.set(id, value);
    return;
  }
  if (existing !== value) {
    index.lengths.delete(id);
    index.conflicts.add(id);
  }
}

function takeLength(index: ContextLengthIndex, id: string): number | undefined {
  if (index.conflicts.has(id)) {
    return undefined;
  }
  const value = index.lengths.get(id);
  if (value === undefined) {
    return undefined;
  }
  return isFinitePositive(value) ? value : undefined;
}
