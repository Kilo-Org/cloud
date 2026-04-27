import { loadSessionStore, resolveSessionStoreEntry } from 'openclaw/plugin-sdk/config-runtime';

type ContextPayload = {
  model: string | null;
  provider: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
};

type SessionEntryUsage = {
  totalTokens?: number;
  totalTokensFresh?: boolean;
  contextTokens?: number;
  model?: string;
  modelProvider?: string;
};

type ModelSelectedCapture = {
  provider?: string;
  model?: string;
};

export function readSessionUsage(params: {
  storePath: string;
  sessionKey: string;
}): SessionEntryUsage | undefined {
  try {
    const store = loadSessionStore(params.storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    return resolved.existing as SessionEntryUsage | undefined;
  } catch (err) {
    console.warn('[kilo-chat] readSessionUsage failed:', err);
    return undefined;
  }
}

export function toContextPayload(
  usage: SessionEntryUsage | undefined,
  selected: ModelSelectedCapture | null
): ContextPayload {
  const freshTotal =
    usage && usage.totalTokensFresh !== false && typeof usage.totalTokens === 'number'
      ? usage.totalTokens
      : null;
  const capacity = usage && typeof usage.contextTokens === 'number' ? usage.contextTokens : null;
  const model = selected?.model ?? usage?.model ?? null;
  const provider = selected?.provider ?? usage?.modelProvider ?? null;
  return {
    model,
    provider,
    contextTokens: freshTotal,
    contextWindow: capacity,
  };
}
