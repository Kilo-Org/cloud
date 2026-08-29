/* eslint-disable jest/no-conditional-in-test -- Storage fixtures route delayed reads; the table runs every origin case. */
import { describe, expect, it } from 'vitest';
import {
  MAX_MEMORY_COUNT,
  MAX_MEMORY_NOTE_LENGTH,
  agentMemoryInputSchema,
  buildPendingMemoryDraft,
} from './agent-memories';
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
    await expect(loadPendingAgentMemoryDraft(storage)).resolves.toStrictEqual({
      ...draft,
      origin: { kind: 'local' },
    });

    const replacement: PendingAgentMemoryDraft = {
      createdAt: 100,
      pageTitle: 'Next',
      pageUrl: 'https://example.com/next',
      text: 'replacement',
    };
    await savePendingAgentMemoryDraft(storage, replacement);
    await expect(loadPendingAgentMemoryDraft(storage)).resolves.toStrictEqual({
      ...replacement,
      origin: { kind: 'local' },
    });

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

const delegatedOrigin = {
  approvalId: 'approval-1',
  expiresAt: 1_800_000_000_000,
  invocationId: 'invocation-1',
  kind: 'delegated' as const,
};

describe('invocation-scoped memory drafts', () => {
  it('retains background selections and their old metadata-free producer form', async () => {
    const storage = createStorage();
    const selection = buildPendingMemoryDraft({
      now: 20,
      pageTitle: 'Background page',
      pageUrl: 'https://example.com/background?private=value',
      selectionText: '  From the context menu  ',
    });
    if (!selection) {
      throw new Error('Expected a selection.');
    }
    await savePendingAgentMemoryDraft(storage, selection);
    const loaded = await loadPendingAgentMemoryDraft(storage);
    await clearPendingAgentMemoryDraft(storage, delegatedOrigin);
    expect(loaded).toMatchObject({
      origin: { kind: 'local' },
      pageUrl: 'https://example.com/background',
      text: 'From the context menu',
    });
    await expect(loadPendingAgentMemoryDraft(storage)).resolves.toStrictEqual(loaded);
  });

  it('does not replace a local draft when the delegated write guard fails', async () => {
    const storage = createStorage();
    await savePendingAgentMemoryDraft(storage, baseInput);
    await expect(
      savePendingAgentMemoryDraft(storage, { ...baseInput, origin: delegatedOrigin }, () => {
        throw new Error('Invocation ended.');
      })
    ).rejects.toThrow('Invocation ended.');
    await expect(loadPendingAgentMemoryDraft(storage)).resolves.toStrictEqual({
      ...baseInput,
      origin: { kind: 'local' },
    });
  });

  it('preserves delegated identity through storage and clears only its matching approval', async () => {
    const storage = createStorage();
    const draft = { ...baseInput, origin: delegatedOrigin };
    await savePendingAgentMemoryDraft(storage, draft);
    const loaded = await loadPendingAgentMemoryDraft(storage);
    await clearPendingAgentMemoryDraft(storage, { ...delegatedOrigin, approvalId: 'older' });
    expect(loaded).toStrictEqual(draft);
    await expect(loadPendingAgentMemoryDraft(storage)).resolves.toStrictEqual(draft);
    await clearPendingAgentMemoryDraft(storage, delegatedOrigin);
    await expect(loadPendingAgentMemoryDraft(storage)).resolves.toBeUndefined();
  });

  it('loads old local records without requiring invocation authority', async () => {
    const storage = createStorage();
    storage.values.set(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY, baseInput);
    await expect(loadPendingAgentMemoryDraft(storage)).resolves.toStrictEqual({
      ...baseInput,
      origin: { kind: 'local' },
    });
  });

  it.each([
    { kind: 'delegated' },
    { ...delegatedOrigin, invocationId: '' },
    { ...delegatedOrigin, approvalId: '' },
    { ...delegatedOrigin, expiresAt: 'tomorrow' },
    { ...delegatedOrigin, kind: 'unknown' },
  ])('rejects malformed origin instead of treating it as local: %j', async origin => {
    const storage = createStorage();
    storage.values.set(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY, { ...baseInput, origin });
    await expect(loadPendingAgentMemoryDraft(storage)).resolves.toBeUndefined();
    expect(storage.values.has(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY)).toBe(false);
  });

  it.each([
    { kind: 'local' as const },
    { ...delegatedOrigin, approvalId: 'approval-2', invocationId: 'invocation-2' },
    { ...delegatedOrigin, approvalId: 'approval-2' },
  ])('preserves a replacement during an asynchronous clear: %j', async origin => {
    const storage = createStorage();
    const draft = { ...baseInput, origin: delegatedOrigin };
    await savePendingAgentMemoryDraft(storage, draft);
    const readStarted = Promise.withResolvers<void>();
    const read = Promise.withResolvers<unknown>();
    const getItem = storage.getItem.bind(storage);
    let delayRead = true;
    storage.getItem = key => {
      if (delayRead && key === PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY) {
        delayRead = false;
        readStarted.resolve();
        return read.promise;
      }
      return getItem(key);
    };
    const clearing = clearPendingAgentMemoryDraft(storage, delegatedOrigin);
    await readStarted.promise;
    const replacement = { ...baseInput, origin, text: 'new selection' };
    const replacing = savePendingAgentMemoryDraft(storage, replacement);
    read.resolve(draft);
    await Promise.all([clearing, replacing]);
    await expect(loadPendingAgentMemoryDraft(storage)).resolves.toStrictEqual(replacement);
  });
});
