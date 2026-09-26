import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { atom, createStore } from 'jotai/vanilla';
import { MiniDb } from 'jotai-minidb';
import type { PersistedWorktreeReviewDraft } from './worktree-review-state';

const require = createRequire(import.meta.url);

const emptyDraft: PersistedWorktreeReviewDraft = {
  version: 1,
  comments: [],
  editor: null,
  overall: '',
  destinationKiloSessionId: null,
  allowOlderCapture: false,
};

function persistenceModule(): typeof import('./worktree-review-persistence') {
  return require('./worktree-review-persistence');
}

function withBrowser<T>(callback: () => T): T {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  try {
    return callback();
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
}

describe('worktree review IndexedDB persistence', () => {
  it('turns synchronous MiniDb construction failure into an in-memory no-op', async () => {
    await withBrowser(async () => {
      const { createWorktreeReviewPersistence } = persistenceModule();
      const persistence = createWorktreeReviewPersistence({
        createDb: () => {
          throw new Error('BroadcastChannel unavailable');
        },
      });
      assert.equal(await persistence.load('scope'), null);
      await persistence.save('scope', emptyDraft);
      await persistence.clear('scope');
    });
  });

  it('bounds an initialization that never completes and makes later operations no-ops', async () => {
    const previousIndexedDb = globalThis.indexedDB;
    const previousBroadcastChannel = globalThis.BroadcastChannel;
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: { open: () => ({}) },
    });
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      value: class {
        close() {}
        postMessage() {}
      },
    });
    await withBrowser(async () => {
      try {
        const { createWorktreeReviewPersistence } = persistenceModule();
        const persistence = createWorktreeReviewPersistence({
          timeoutMs: 5,
          createDb: () => new MiniDb({ name: 'review-timeout-test' }),
        });
        assert.equal(await persistence.load('scope'), null);
        await persistence.save('scope', emptyDraft);
        await persistence.clear('scope');
      } finally {
        Object.defineProperty(globalThis, 'indexedDB', {
          configurable: true,
          value: previousIndexedDb,
        });
        Object.defineProperty(globalThis, 'BroadcastChannel', {
          configurable: true,
          value: previousBroadcastChannel,
        });
      }
    });
  });

  it('maps per-key clear to MiniDb delete rather than database-wide clear', async () => {
    await withBrowser(async () => {
      const { createWorktreeReviewPersistence } = persistenceModule();
      const valuesAtom = atom<Record<string, PersistedWorktreeReviewDraft>>({});
      const store = createStore();
      const deleted: string[] = [];
      let cleared = false;
      const fakeDatabase = {
        items: valuesAtom,
        item: (key: string) => atom(get => get(valuesAtom)[key]),
        set: atom(null, (get, set, key: string, value: PersistedWorktreeReviewDraft) => {
          set(valuesAtom, { ...get(valuesAtom), [key]: value });
        }),
        delete: atom(null, (get, set, key: string) => {
          deleted.push(key);
          const next = { ...get(valuesAtom) };
          delete next[key];
          set(valuesAtom, next);
        }),
        clear: atom(null, () => {
          cleared = true;
        }),
      } as unknown as MiniDb<PersistedWorktreeReviewDraft>;
      store.set(valuesAtom, {
        'first-scope': emptyDraft,
        'other-scope': emptyDraft,
      });
      const persistence = createWorktreeReviewPersistence({
        store,
        createDb: () => fakeDatabase,
      });
      await persistence.clear('first-scope');
      assert.deepEqual(deleted, ['first-scope']);
      assert.equal(cleared, false);
      assert.equal(store.get(valuesAtom)['first-scope'], undefined);
      assert.equal(store.get(valuesAtom)['other-scope'], emptyDraft);

      const configurationOnly = {
        ...emptyDraft,
        destinationKiloSessionId: 'destination-only',
        allowOlderCapture: true,
      };
      await persistence.save('configuration-only', configurationOnly);
      assert.equal(store.get(valuesAtom)['configuration-only'], configurationOnly);
    });
  });
});
