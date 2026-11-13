import { describe, expect, it, vi } from 'vitest';

const draftStorage = new Map<string, unknown>();

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  storage: {
    getItem: (key: string) => draftStorage.get(key) ?? null,
    removeItem: (key: string) => {
      draftStorage.delete(key);
    },
    setItem: (key: string, value: unknown) => {
      draftStorage.set(key, value);
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

    expect(draftStorage.get(draftStorageKey)).toStrictEqual({});
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
});
