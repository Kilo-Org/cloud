import type { z } from 'zod';
import {
  MAX_MEMORY_COUNT,
  agentMemoryInputSchema,
  agentMemorySchema,
  matchesDelegatedApproval,
  pendingAgentMemoryDraftSchema,
  storedAgentMemoriesSchema,
} from './agent-memories';
import type {
  AgentMemory,
  AgentMemoryInput,
  DelegatedApprovalOrigin,
  NormalizedPendingAgentMemoryDraft,
  PendingAgentMemoryDraft,
} from './agent-memories';
import type { ExecutionGuard } from './agent-tool-results';

const draftStorageQueues = new Map<string, Promise<void>>();

/** Serialize comparison and removal with every draft writer, including background selections. */
export const withPendingDraftStorageLock = async <Result>(
  key: string,
  work: () => Promise<Result>
): Promise<Result> => {
  const previous = draftStorageQueues.get(key);
  const finished = Promise.withResolvers<void>();
  draftStorageQueues.set(key, finished.promise);
  try {
    await previous;
    const locks = globalThis.navigator?.locks;
    // Old local-only environments without Web Locks retain their in-context storage behavior.
    // Remove this fallback after those environments retire; delegation requires native locks.
    return locks === undefined ? await work() : await locks.request(key, work);
  } finally {
    finished.resolve();
    if (draftStorageQueues.get(key) === finished.promise) {
      draftStorageQueues.delete(key);
    }
  }
};

export const AGENT_MEMORIES_STORAGE_KEY = 'local:kiloAgentMemories';
export const PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY = 'local:kiloPendingAgentMemoryDraft';

type MaybePromise<Value> = Promise<Value> | Value;

type AgentMemoriesStorageKey =
  | typeof AGENT_MEMORIES_STORAGE_KEY
  | typeof PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY;

export interface AgentMemoriesStorageArea {
  getItem(key: AgentMemoriesStorageKey): MaybePromise<unknown>;
  setItem(key: AgentMemoriesStorageKey, value: unknown): MaybePromise<void>;
  removeItem(key: AgentMemoriesStorageKey): MaybePromise<void>;
}

export class AgentMemoryStoreFullError extends Error {
  constructor(message = 'Agent memory store is full.') {
    super(message);
    this.name = 'AgentMemoryStoreFullError';
  }
}

const toAgentMemory = (value: z.infer<typeof agentMemorySchema>): AgentMemory => ({
  createdAt: value.createdAt,
  id: value.id,
  pageTitle: value.pageTitle,
  pageUrl: value.pageUrl,
  text: value.text,
  ...(value.note === undefined ? {} : { note: value.note }),
  ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
});

const toPendingDraft = (
  value: z.infer<typeof pendingAgentMemoryDraftSchema>
): NormalizedPendingAgentMemoryDraft => ({
  createdAt: value.createdAt,
  // Old local draft records lack origin; the schema normalizes them until those records retire.
  origin: value.origin,
  pageTitle: value.pageTitle,
  pageUrl: value.pageUrl,
  text: value.text,
  ...(value.note === undefined ? {} : { note: value.note }),
  ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
});

export const normalizeAgentMemories = (value: unknown): AgentMemory[] => {
  const parsed = storedAgentMemoriesSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }

  return parsed.data.flatMap(entry => {
    const memory = agentMemorySchema.safeParse(entry);
    return memory.success ? [toAgentMemory(memory.data)] : [];
  });
};

export const loadAgentMemories = async (
  storageArea: AgentMemoriesStorageArea
): Promise<AgentMemory[]> =>
  normalizeAgentMemories(await storageArea.getItem(AGENT_MEMORIES_STORAGE_KEY));

export const saveAgentMemories = async (
  storageArea: AgentMemoriesStorageArea,
  memories: readonly AgentMemory[]
): Promise<void> => {
  await storageArea.setItem(AGENT_MEMORIES_STORAGE_KEY, normalizeAgentMemories(memories));
};

export const addAgentMemory = async (
  storageArea: AgentMemoriesStorageArea,
  input: AgentMemoryInput,
  // Old local storage callers omit the guard. Remove this optional form after those callers retire.
  executionGuard?: ExecutionGuard
): Promise<AgentMemory> => {
  const parsedInput = agentMemoryInputSchema.parse(input);
  const memories = await loadAgentMemories(storageArea);

  if (memories.length >= MAX_MEMORY_COUNT) {
    throw new AgentMemoryStoreFullError();
  }

  const trimmedNote = parsedInput.note?.trim();
  const candidate: AgentMemory = {
    createdAt: parsedInput.createdAt,
    id: crypto.randomUUID(),
    pageTitle: parsedInput.pageTitle,
    pageUrl: parsedInput.pageUrl,
    text: parsedInput.text,
    ...(parsedInput.truncated === undefined ? {} : { truncated: parsedInput.truncated }),
    ...(trimmedNote === undefined || trimmedNote.length === 0 ? {} : { note: trimmedNote }),
  };

  const memory = toAgentMemory(agentMemorySchema.parse(candidate));
  executionGuard?.();
  await saveAgentMemories(storageArea, [...memories, memory]);
  return memory;
};

export const deleteAgentMemory = async (
  storageArea: AgentMemoriesStorageArea,
  id: string
): Promise<void> => {
  const memories = await loadAgentMemories(storageArea);
  await saveAgentMemories(
    storageArea,
    memories.filter(memory => memory.id !== id)
  );
};

export const savePendingAgentMemoryDraft = (
  storageArea: AgentMemoriesStorageArea,
  draft: PendingAgentMemoryDraft,
  // Old local storage callers omit the guard. Remove this optional form after those callers retire.
  executionGuard?: ExecutionGuard
): Promise<void> =>
  withPendingDraftStorageLock(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY, async () => {
    const parsed = toPendingDraft(pendingAgentMemoryDraftSchema.parse(draft));
    executionGuard?.();
    await storageArea.setItem(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY, parsed);
  });

export const loadPendingAgentMemoryDraft = (
  storageArea: AgentMemoriesStorageArea
): Promise<NormalizedPendingAgentMemoryDraft | undefined> =>
  withPendingDraftStorageLock(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY, async () => {
    const value = await storageArea.getItem(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY);
    if (value === null || value === undefined) {
      return;
    }

    const parsed = pendingAgentMemoryDraftSchema.safeParse(value);
    if (!parsed.success) {
      await storageArea.removeItem(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY);
      return;
    }

    return toPendingDraft(parsed.data);
  });

export const clearPendingAgentMemoryDraft = (
  storageArea: AgentMemoriesStorageArea,
  expected?: DelegatedApprovalOrigin
): Promise<void> =>
  withPendingDraftStorageLock(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY, async () => {
    if (expected !== undefined) {
      const current = pendingAgentMemoryDraftSchema.safeParse(
        await storageArea.getItem(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY)
      );
      if (!current.success || !matchesDelegatedApproval(current.data.origin, expected)) {
        return;
      }
    }
    // Old local callers clear the sole draft without an invocation comparison.
    // Remove that call form only after all old local draft producers retire.
    await storageArea.removeItem(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY);
  });
