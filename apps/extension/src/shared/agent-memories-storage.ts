import type { z } from 'zod';
import {
  MAX_MEMORY_COUNT,
  agentMemoryInputSchema,
  agentMemorySchema,
  pendingAgentMemoryDraftSchema,
  storedAgentMemoriesSchema,
} from './agent-memories';
import type { AgentMemory, AgentMemoryInput, PendingAgentMemoryDraft } from './agent-memories';

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
): PendingAgentMemoryDraft => ({
  createdAt: value.createdAt,
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
  input: AgentMemoryInput
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

export const savePendingAgentMemoryDraft = async (
  storageArea: AgentMemoriesStorageArea,
  draft: PendingAgentMemoryDraft
): Promise<void> => {
  const parsed = toPendingDraft(pendingAgentMemoryDraftSchema.parse(draft));
  await storageArea.setItem(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY, parsed);
};

export const loadPendingAgentMemoryDraft = async (
  storageArea: AgentMemoriesStorageArea
): Promise<PendingAgentMemoryDraft | undefined> => {
  const value = await storageArea.getItem(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY);
  if (value === null || value === undefined) {
    return undefined;
  }

  const parsed = pendingAgentMemoryDraftSchema.safeParse(value);
  if (!parsed.success) {
    await storageArea.removeItem(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY);
    return undefined;
  }

  return toPendingDraft(parsed.data);
};

export const clearPendingAgentMemoryDraft = async (
  storageArea: AgentMemoriesStorageArea
): Promise<void> => {
  await storageArea.removeItem(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY);
};
