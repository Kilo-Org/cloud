import { describe, expect, it, vi } from 'vitest';

const draftStorage = new Map<string, unknown>();
const storageWrites: { rejectNext: boolean; values: unknown[] } = { rejectNext: false, values: [] };
const storageRead: { deferred?: (() => unknown) | undefined } = {};

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  storage: {
    getItem: (key: string) => storageRead.deferred?.() ?? draftStorage.get(key) ?? null,
    removeItem: (key: string) => {
      draftStorage.delete(key);
    },
    setItem: (key: string, value: unknown) => {
      if (storageWrites.rejectNext) {
        storageWrites.rejectNext = false;
        return Promise.reject(new Error('quota exceeded'));
      }

      storageWrites.values.push(value);
      draftStorage.set(key, value);
      return Promise.resolve();
    },
  },
}));

const draftStorageKey = 'local:kiloAgentDrafts';
interface DraftStorage {
  clearStoredDrafts: () => Promise<void>;
  hydrateStoredDrafts: () => Promise<Record<string, string>>;
  persistDraft: (conversationId: string, text: string) => void;
}
const loadDraftStorage = (): Promise<DraftStorage> => {
  vi.resetModules();

  return import('./agent-draft-storage');
};

describe('agent draft storage', () => {
  it('keeps a draft across a module reload', async () => {
    draftStorage.clear();
    const before = await loadDraftStorage();
    await before.hydrateStoredDrafts();
    before.persistDraft('conversation-1', 'half typed question');

    const after = await loadDraftStorage();

    await expect(after.hydrateStoredDrafts()).resolves.toStrictEqual({
      'conversation-1': 'half typed question',
    });
  });

  it('drops a cleared draft', async () => {
    draftStorage.clear();
    const drafts = await loadDraftStorage();
    await drafts.hydrateStoredDrafts();
    drafts.persistDraft('conversation-1', 'sent text');
    drafts.persistDraft('conversation-1', '');

    await vi.waitFor(() => {
      expect(draftStorage.get(draftStorageKey)).toStrictEqual({});
    });
  });

  it('keeps stored drafts when an edit lands before hydration finishes', async () => {
    draftStorage.clear();
    draftStorage.set(draftStorageKey, { 'conversation-1': 'typed before reload' });
    const drafts = await loadDraftStorage();
    drafts.persistDraft('conversation-2', 'typed immediately');

    await expect(drafts.hydrateStoredDrafts()).resolves.toStrictEqual({
      'conversation-1': 'typed before reload',
      'conversation-2': 'typed immediately',
    });
    expect(draftStorage.get(draftStorageKey)).toStrictEqual({
      'conversation-1': 'typed before reload',
      'conversation-2': 'typed immediately',
    });
  });

  it('ignores a malformed store instead of throwing', async () => {
    draftStorage.clear();
    draftStorage.set(draftStorageKey, ['not', 'a', 'map']);
    const drafts = await loadDraftStorage();

    await expect(drafts.hydrateStoredDrafts()).resolves.toStrictEqual({});
  });

  it('leaves nothing for the next account after a sign-out clears the drafts', async () => {
    draftStorage.clear();
    const drafts = await loadDraftStorage();
    await drafts.hydrateStoredDrafts();
    drafts.persistDraft('conversation-1', 'first account draft');

    await drafts.clearStoredDrafts();

    expect(draftStorage.has(draftStorageKey)).toBe(false);
    await expect(drafts.hydrateStoredDrafts()).resolves.toStrictEqual({});
    expect(draftStorage.has(draftStorageKey)).toBe(false);
  });

  it('serializes a burst of edits and ends on the latest draft', async () => {
    draftStorage.clear();
    const drafts = await loadDraftStorage();
    await drafts.hydrateStoredDrafts();
    storageWrites.values.length = 0;

    drafts.persistDraft('conversation-1', 'a');
    drafts.persistDraft('conversation-1', 'ab');
    drafts.persistDraft('conversation-1', 'abc');

    await vi.waitFor(() => {
      expect(storageWrites.values).toStrictEqual([
        { 'conversation-1': 'a' },
        { 'conversation-1': 'abc' },
      ]);
    });
  });

  it('keeps the in-memory draft when the write rejects', async () => {
    draftStorage.clear();
    const drafts = await loadDraftStorage();
    await drafts.hydrateStoredDrafts();

    storageWrites.rejectNext = true;
    drafts.persistDraft('conversation-1', 'typed');

    await vi.waitFor(() => {
      expect(storageWrites.rejectNext).toBe(false);
    });
    await expect(drafts.hydrateStoredDrafts()).resolves.toStrictEqual({
      'conversation-1': 'typed',
    });
  });

  it('ignores a read that was in flight when a sign-out cleared the drafts', async () => {
    draftStorage.clear();
    const drafts = await loadDraftStorage();
    const { promise: pendingRead, resolve: releaseRead } = Promise.withResolvers<unknown>();
    storageRead.deferred = () => pendingRead;

    const hydration = drafts.hydrateStoredDrafts();
    await drafts.clearStoredDrafts();
    releaseRead({ 'conversation-1': 'first account draft' });

    await expect(hydration).resolves.toStrictEqual({});
    storageRead.deferred = undefined;
    await expect(drafts.hydrateStoredDrafts()).resolves.toStrictEqual({});
    expect(draftStorage.has(draftStorageKey)).toBe(false);
  });
});
