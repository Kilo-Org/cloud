import { describe, expect, it } from 'vitest';
import { MAX_MEMORY_COUNT, MAX_MEMORY_NOTE_LENGTH, agentMemoryInputSchema } from './agent-memories';
import type { AgentMemory, PendingAgentMemoryDraft } from './agent-memories';
import {
  AGENT_MEMORIES_STORAGE_KEY,
  AgentMemoryStoreFullError,
  PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY,
  addAgentMemory,
  clearPendingAgentMemoryDraft,
  deleteAgentMemory,
  loadAgentMemories,
  loadPendingAgentMemoryDraft,
  saveAgentMemories,
  savePendingAgentMemoryDraft,
} from './agent-memories-storage';
import type { AgentMemoriesStorageArea } from './agent-memories-storage';

const createStorage = (): AgentMemoriesStorageArea & {
  values: Map<string, unknown>;
} => {
  const values = new Map<string, unknown>();

  return {
    getItem: key => values.get(key),
    removeItem: key => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
    values,
  };
};

const baseInput = {
  createdAt: 1_700_000_000_000,
  pageTitle: 'Example',
  pageUrl: 'https://example.com/path',
  text: 'selected text',
};

describe('agent memories storage', () => {
  it('loads an empty list for missing or malformed storage and drops invalid entries', async () => {
    const storage = createStorage();
    await expect(loadAgentMemories(storage)).resolves.toStrictEqual([]);

    storage.values.set(AGENT_MEMORIES_STORAGE_KEY, { wrong: true });
    await expect(loadAgentMemories(storage)).resolves.toStrictEqual([]);

    const valid: AgentMemory = {
      ...baseInput,
      id: 'keep-me',
    };
    storage.values.set(AGENT_MEMORIES_STORAGE_KEY, [
      valid,
      { id: '', text: 'bad' },
      { ...valid, id: 'note-too-long', note: 'n'.repeat(MAX_MEMORY_NOTE_LENGTH + 1) },
    ]);
    await expect(loadAgentMemories(storage)).resolves.toStrictEqual([valid]);
  });

  it('assigns id, copies createdAt, and trims blank notes', async () => {
    const storage = createStorage();
    const saved = await addAgentMemory(storage, {
      ...baseInput,
      note: '  keep me  ',
    });

    expect(saved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(saved.createdAt).toBe(baseInput.createdAt);
    expect(saved.note).toBe('keep me');

    const blankNote = await addAgentMemory(storage, {
      ...baseInput,
      createdAt: baseInput.createdAt + 1,
      note: '   ',
      text: 'second',
    });
    expect(blankNote).not.toHaveProperty('note');
  });

  it('enforces the note length cap at the schema boundary', async () => {
    const storage = createStorage();

    expect(() =>
      agentMemoryInputSchema.parse({
        ...baseInput,
        note: 'n'.repeat(MAX_MEMORY_NOTE_LENGTH + 1),
      })
    ).toThrow(/too_big|max/i);

    const atCap = await addAgentMemory(storage, {
      ...baseInput,
      note: 'n'.repeat(MAX_MEMORY_NOTE_LENGTH),
      text: 'third',
    });
    expect(atCap.note).toHaveLength(MAX_MEMORY_NOTE_LENGTH);

    await expect(
      addAgentMemory(storage, {
        ...baseInput,
        note: 'n'.repeat(MAX_MEMORY_NOTE_LENGTH + 1),
        text: 'fail',
      })
    ).rejects.toThrow(/too_big|max/i);
  });

  it('throws AgentMemoryStoreFullError at the 200-memory cap', async () => {
    const storage = createStorage();
    const full: AgentMemory[] = Array.from({ length: MAX_MEMORY_COUNT }, (_unused, index) => ({
      ...baseInput,
      createdAt: index,
      id: `id-${index}`,
      text: `text ${index}`,
    }));
    await saveAgentMemories(storage, full);

    await expect(addAgentMemory(storage, baseInput)).rejects.toBeInstanceOf(
      AgentMemoryStoreFullError
    );
    await expect(addAgentMemory(storage, baseInput)).rejects.toMatchObject({
      name: 'AgentMemoryStoreFullError',
    });
  });

  it('deletes by id and round-trips pending drafts', async () => {
    const storage = createStorage();
    const first = await addAgentMemory(storage, baseInput);
    const second = await addAgentMemory(storage, {
      ...baseInput,
      createdAt: baseInput.createdAt + 1,
      text: 'second',
    });

    await deleteAgentMemory(storage, first.id);
    await expect(loadAgentMemories(storage)).resolves.toStrictEqual([second]);

    const draft: PendingAgentMemoryDraft = {
      createdAt: 99,
      pageTitle: 'Draft page',
      pageUrl: 'https://example.com/draft',
      text: 'pending selection',
      truncated: true,
    };
    await savePendingAgentMemoryDraft(storage, draft);
    await expect(loadPendingAgentMemoryDraft(storage)).resolves.toStrictEqual(draft);

    const replacement: PendingAgentMemoryDraft = {
      createdAt: 100,
      pageTitle: 'Next',
      pageUrl: 'https://example.com/next',
      text: 'replacement',
    };
    await savePendingAgentMemoryDraft(storage, replacement);
    await expect(loadPendingAgentMemoryDraft(storage)).resolves.toStrictEqual(replacement);

    await clearPendingAgentMemoryDraft(storage);
    await expect(loadPendingAgentMemoryDraft(storage)).resolves.toBeUndefined();
  });

  it('returns undefined and clears an invalid pending draft', async () => {
    const storage = createStorage();
    storage.values.set(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY, { bad: true });

    await expect(loadPendingAgentMemoryDraft(storage)).resolves.toBeUndefined();
    expect(storage.values.has(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY)).toBe(false);
  });
});
