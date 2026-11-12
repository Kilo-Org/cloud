import { beforeEach, describe, expect, it, vi } from 'vitest';

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
type DraftStorage = {
  hydrateStoredDrafts: () => Promise<Record<string, string>>;
  persistDraft: (conversationId: string, text: string) => void;
};
const loadDraftStorage = async (): Promise<DraftStorage> => {
  vi.resetModules();

  return import('./agent-draft-storage');
};

beforeEach(() => {
  draftStorage.clear();
});

describe('agent draft storage', () => {
  it('keeps a draft across a module reload', async () => {
    const before = await loadDraftStorage();
    await before.hydrateStoredDrafts();
    before.persistDraft('conversation-1', 'half typed question');

    const after = await loadDraftStorage();

    expect(await after.hydrateStoredDrafts()).toEqual({
      'conversation-1': 'half typed question',
    });
  });

  it('drops a cleared draft', async () => {
    const drafts = await loadDraftStorage();
    await drafts.hydrateStoredDrafts();
    drafts.persistDraft('conversation-1', 'sent text');
    drafts.persistDraft('conversation-1', '');

    expect(draftStorage.get(draftStorageKey)).toEqual({});
  });

  it('keeps stored drafts when an edit lands before hydration finishes', async () => {
    draftStorage.set(draftStorageKey, { 'conversation-1': 'typed before reload' });
    const drafts = await loadDraftStorage();
    drafts.persistDraft('conversation-2', 'typed immediately');

    expect(await drafts.hydrateStoredDrafts()).toEqual({
      'conversation-1': 'typed before reload',
      'conversation-2': 'typed immediately',
    });
    expect(draftStorage.get(draftStorageKey)).toEqual({
      'conversation-1': 'typed before reload',
      'conversation-2': 'typed immediately',
    });
  });

  it('ignores a malformed store instead of throwing', async () => {
    draftStorage.set(draftStorageKey, ['not', 'a', 'map']);
    const drafts = await loadDraftStorage();

    expect(await drafts.hydrateStoredDrafts()).toEqual({});
  });
});
