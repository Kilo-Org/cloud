/* eslint-disable max-lines -- one mounted composer harness proves real-store recovery and generation fencing */
/* eslint-disable typescript-eslint/no-deprecated -- React Native tests use the installed DOM-free renderer */
/* eslint-disable require-await, typescript-eslint/require-await -- native fixtures and async act callbacks settle synchronously */
// eslint-disable-next-line import/no-nodejs-modules -- the Expo adapter drives real SQLite through the installed Node runtime
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthenticatedOwner } from '@/lib/context-scope';
import type * as DraftHooks from './use-draft-load';

const mocks = vi.hoisted(() => ({
  secure: new Map<string, string>(),
  readKey: vi.fn(),
  open: vi.fn(),
  removeDatabase: vi.fn(),
  random: vi.fn(),
  hasCipher: true,
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: mocks.readKey,
  setItemAsync: async (key: string, value: string) => {
    mocks.secure.set(key, value);
  },
}));
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: mocks.random }));
vi.mock('expo-sqlite', () => ({
  openDatabaseSync: mocks.open,
  deleteDatabaseAsync: mocks.removeDatabase,
}));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

let database: DatabaseSync | undefined = undefined;
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let hooks: typeof DraftHooks | undefined = undefined;
let owner: AuthenticatedOwner = { authEpoch: 0, generation: 0, userId: null };
let key = '';
const observed: { current: ReturnType<typeof DraftHooks.useScopedDraftLoad<string>> | null } = {
  current: null,
};

function nativeStatement(statement: StatementSync) {
  const returnsRows = statement.columns().length > 0;
  return {
    executeSync: (params: SQLInputValue[] = []) => {
      if (!returnsRows) {
        const result = statement.run(...params);
        return {
          changes: result.changes,
          lastInsertRowId: result.lastInsertRowid,
          getAllSync: () => [],
          getFirstSync: () => null,
        };
      }
      const rows = statement.all(...params);
      return {
        changes: 0,
        lastInsertRowId: 0,
        getAllSync: () => rows,
        getFirstSync: () => rows[0] ?? null,
      };
    },
    executeForRawResultSync: (params: SQLInputValue[] = []) => ({
      getAllSync: () => statement.all(...params).map(row => Object.values(row)),
    }),
  };
}
function nativeClient() {
  const db = database;
  if (!db) {
    throw new Error('Database fixture is absent');
  }
  return {
    getFirstSync: (source: string) => {
      if (source === 'PRAGMA cipher_version') {
        return mocks.hasCipher ? { cipher_version: '4.5' } : null;
      }
      return db.prepare(source).get() ?? null;
    },
    execSync: (source: string) => {
      db.exec(source);
    },
    prepareSync: (source: string) => nativeStatement(db.prepare(source)),
    // Native handles close independently of the durable file. The backing SQLite stays until teardown.
    closeAsync: async () => undefined,
  };
}
function Composer({
  prefill = '',
  selection = 0,
  entityKey = key,
}: {
  prefill?: string;
  selection?: number;
  entityKey?: string;
}) {
  if (!hooks) {
    throw new Error('Draft hooks are absent');
  }
  const draft = hooks.useScopedDraftLoad({
    owner,
    entityKey,
    selectionGeneration: selection,
    isReady: true,
  });
  observed.current = draft;
  return createElement('composer', {
    status: draft.status,
    restored: draft.value,
    prefill,
    onChangeText: draft.save,
  });
}
function currentDraft() {
  if (!observed.current) {
    throw new Error('Composer did not mount');
  }
  return observed.current;
}
async function mount(prefill = '') {
  await act(async () => {
    renderer = TestRenderer.create(createElement(Composer, { prefill }));
  });
}
function stored(userId = 'account-a', entityKey = key) {
  return database
    ?.prepare('SELECT v FROM kv WHERE scope = ? AND k = ?')
    .get(`draft:${userId}`, entityKey)?.v;
}
async function signIn(userId: string) {
  const epochs = await import('@/lib/auth/auth-epoch');
  const context = await import('@/lib/context-scope');
  epochs.bumpAuthEpoch();
  context.beginAuthenticatedOwner();
  context.confirmAuthenticatedOwner(context.getAuthenticatedOwner(), userId);
  owner = context.getAuthenticatedOwner();
}
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  database = new DatabaseSync(':memory:');
  observed.current = null;
  mocks.secure.clear();
  mocks.hasCipher = true;
  mocks.readKey.mockImplementation(
    async (storageKey: string) => mocks.secure.get(storageKey) ?? null
  );
  mocks.random.mockResolvedValue(new Uint8Array(32).fill(9));
  mocks.open.mockImplementation(nativeClient);
  const keys = await import('./scoped-draft-keys');
  key = keys.scopedDraftKey({ kind: 'personal' }, { kind: 'new-session' });
  const store = await import('./encrypted-kv');
  await store.setItem('draft:account-a', key, '"saved a"');
  await store.setItem('draft:account-b', key, '"saved b"');
  await store.setItem('draft:account-a', 'agent-composer:new', '"legacy a"');
  // Simulate a cold process before the scenario. No module reset or test-only open reset runs after failure.
  vi.resetModules();
  vi.clearAllMocks();
  hooks = await import('./use-draft-load');
  await signIn('account-a');
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  const drafts = await import('./drafts');
  drafts.resetDraftTimersForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  database?.close();
  database = undefined;
});

describe('strict mounted composer persistence', () => {
  it('retains a typed malformed result after external repair until an explicit Retry restores the value', async () => {
    database
      ?.prepare('UPDATE kv SET v = ? WHERE scope = ? AND k = ?')
      .run('42', 'draft:account-a', key);
    await mount();
    expect(currentDraft().status).toBe('malformed');
    database
      ?.prepare('UPDATE kv SET v = ? WHERE scope = ? AND k = ?')
      .run('"repaired"', 'draft:account-a', key);
    expect(currentDraft().canWrite).toBe(false);
    await act(async () => {
      await currentDraft().retry();
    });
    expect(currentDraft()).toMatchObject({ status: 'present', value: 'repaired', canWrite: true });
    expect(stored()).toBe('"repaired"');
  });
  it('flushes already-admitted draft work on an ordinary unmount without granting unresolved writes', async () => {
    await mount();
    const admitted = currentDraft();
    admitted.save('leaving text');
    await act(async () => {
      renderer?.unmount();
    });
    await admitted.flush();
    expect(stored()).toBe('"leaving text"');
  });
  it.each(['debounce', 'flush'])(
    'preserves an admitted edit across a context switch through %s while the replacement stays protected',
    async completion => {
      await mount();
      vi.useFakeTimers();
      const admitted = currentDraft();
      const keys = await import('./scoped-draft-keys');
      const replacementKey = keys.scopedDraftKey(
        { kind: 'organization', organizationId: 'org-a' },
        { kind: 'new-session' }
      );
      const store = await import('./encrypted-kv');
      await store.setItem('draft:account-a', replacementKey, '"replacement text"');
      const gate = Promise.withResolvers<string | null>();
      const read = vi.spyOn(store, 'getItem').mockReturnValueOnce(gate.promise);
      admitted.save('leaving context text');
      await act(async () => {
        renderer?.update(createElement(Composer, { entityKey: replacementKey, selection: 1 }));
      });
      expect(currentDraft()).toMatchObject({ status: 'unresolved', canWrite: false });
      await act(async () => {
        admitted.save('stale edit');
        currentDraft().save('unresolved edit');
        await currentDraft().flush();
        expect(await currentDraft().clear()).toBe(false);
        expect(await currentDraft().importLegacy('agent-composer:new')).toBe('stale');
        await (completion === 'flush' ? admitted.flush() : vi.advanceTimersByTimeAsync(500));
      });
      expect(stored()).toBe('"leaving context text"');
      expect(stored('account-a', replacementKey)).toBe('"replacement text"');
      await act(async () => {
        gate.resolve('"replacement text"');
      });
      read.mockRestore();
      await act(async () => {
        renderer?.update(createElement(Composer, { selection: 2 }));
      });
      expect(currentDraft()).toMatchObject({
        status: 'present',
        value: 'leaving context text',
        canWrite: true,
      });
    }
  );
  it('rejects an admitted pending save after account replacement without changing either account draft', async () => {
    await mount();
    vi.useFakeTimers();
    const admitted = currentDraft();
    admitted.save('pending a');
    await act(async () => {
      await signIn('account-b');
      renderer?.update(createElement(Composer));
    });
    await act(async () => {
      await admitted.flush();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(stored('account-a')).toBe('"saved a"');
    expect(stored('account-b')).toBe('"saved b"');
    expect(currentDraft()).toMatchObject({ status: 'present', value: 'saved b', canWrite: true });
  });
  it.each([
    { replacement: 'account', restored: 'saved b' },
    { replacement: 'key', restored: 'saved replacement' },
    { replacement: 'selection', restored: 'saved a' },
  ])(
    'ignores the old Retry after $replacement replacement restores without revoking the replacement write grant',
    async ({ replacement, restored }) => {
      mocks.readKey.mockRejectedValueOnce(new Error('temporary keychain failure'));
      await mount();
      expect(currentDraft().status).toBe('failed');
      const oldRetry = currentDraft().retry;
      const keys = await import('./scoped-draft-keys');
      const replacementKey =
        replacement === 'key' ? keys.scopedDraftKey({ kind: 'personal' }, { kind: 'search' }) : key;
      if (replacement === 'key') {
        database
          ?.prepare('INSERT INTO kv (scope, k, v, updated_at) VALUES (?, ?, ?, ?)')
          .run('draft:account-a', replacementKey, '"saved replacement"', Date.now());
      }
      await act(async () => {
        if (replacement === 'account') {
          await signIn('account-b');
        }
        renderer?.update(createElement(Composer, { entityKey: replacementKey, selection: 1 }));
      });
      await act(async () => {
        await currentDraft().retry();
      });
      expect(currentDraft()).toMatchObject({ status: 'present', value: restored, canWrite: true });
      await act(async () => {
        await oldRetry();
      });
      expect(currentDraft()).toMatchObject({ status: 'present', value: restored, canWrite: true });
      await act(async () => {
        currentDraft().save('edited replacement');
        await currentDraft().flush();
      });
      expect(stored(replacement === 'account' ? 'account-b' : 'account-a', replacementKey)).toBe(
        '"edited replacement"'
      );
    }
  );
  it('ignores a failed Retry callback after a newer retry restores the same draft', async () => {
    mocks.readKey.mockRejectedValueOnce(new Error('temporary keychain failure'));
    await mount();
    const oldRetry = currentDraft().retry;
    await act(async () => {
      await currentDraft().retry();
    });
    await act(async () => {
      await oldRetry();
      currentDraft().save('edit after recovery');
      await currentDraft().flush();
    });
    expect(stored()).toBe('"edit after recovery"');
    expect(currentDraft()).toMatchObject({ status: 'present', canWrite: true });
  });
  it('restores saved text and permits editing only after the strict read succeeds', async () => {
    await mount();
    expect(renderer?.toJSON()).toMatchObject({ props: { status: 'present', restored: 'saved a' } });
    await act(async () => {
      currentDraft().save('edited');
      await currentDraft().flush();
    });
    expect(stored()).toBe('"edited"');
  });
  it('blocks prefill, autosave, flush, clear, and import after a rejected key read, then Retry restores the real store', async () => {
    mocks.readKey.mockRejectedValueOnce(new Error('temporary keychain failure'));
    const savedKey = mocks.secure.get('persist-db-key');
    await mount('prefilled text');
    expect(currentDraft()).toMatchObject({
      status: 'failed',
      canWrite: false,
      recovery: { status: 'retryable', reason: 'secure-store' },
    });
    await act(async () => {
      currentDraft().save('must not overwrite');
      await currentDraft().flush();
      expect(await currentDraft().clear()).toBe(false);
      expect(await currentDraft().importLegacy('agent-composer:new')).toBe('stale');
    });
    expect(stored()).toBe('"saved a"');
    expect(stored('account-a', 'agent-composer:new')).toBe('"legacy a"');
    const store = await import('./encrypted-kv');
    await expect(store.getItem('draft:account-a', key)).rejects.toThrow('secure-store');
    expect(mocks.open).not.toHaveBeenCalled();
    await act(async () => {
      await currentDraft().retry();
    });
    expect(renderer?.toJSON()).toMatchObject({ props: { status: 'present', restored: 'saved a' } });
    expect(stored()).toBe('"saved a"');
    expect(mocks.secure.get('persist-db-key')).toBe(savedKey);
    expect(mocks.removeDatabase).not.toHaveBeenCalled();
    expect(mocks.random).not.toHaveBeenCalled();
  });
  it('coalesces concurrent Retry and retains the successful native handle', async () => {
    mocks.readKey.mockRejectedValueOnce(new Error('temporary keychain failure'));
    await mount();
    await act(async () => {
      await Promise.all([currentDraft().retry(), currentDraft().retry(), currentDraft().retry()]);
    });
    expect(currentDraft()).toMatchObject({ status: 'present', value: 'saved a' });
    await act(async () => {
      currentDraft().save('after retry');
      await currentDraft().flush();
    });
    expect(stored()).toBe('"after retry"');
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });
  it('preserves malformed draft bytes and keeps every write blocked through nondestructive Retry', async () => {
    database
      ?.prepare('UPDATE kv SET v = ? WHERE scope = ? AND k = ?')
      .run('{broken', 'draft:account-a', key);
    await mount('prefill');
    expect(currentDraft()).toMatchObject({ status: 'malformed', canWrite: false });
    await act(async () => {
      currentDraft().save('lost text');
      await currentDraft().flush();
      expect(await currentDraft().clear()).toBe(false);
      await currentDraft().retry();
    });
    expect(currentDraft().status).toBe('malformed');
    expect(stored()).toBe('{broken');
    expect(mocks.removeDatabase).not.toHaveBeenCalled();
  });
  it('treats a genuinely absent scoped record as empty and writable', async () => {
    const keys = await import('./scoped-draft-keys');
    const emptyKey = keys.scopedDraftKey({ kind: 'personal' }, { kind: 'search' });
    await act(async () => {
      renderer = TestRenderer.create(createElement(Composer, { entityKey: emptyKey }));
    });
    expect(currentDraft()).toMatchObject({ status: 'absent', canWrite: true, value: null });
    await act(async () => {
      currentDraft().save('query');
      await currentDraft().flush();
    });
    expect(stored('account-a', emptyKey)).toBe('"query"');
  });
  it('abandons the old account restore and actions while the store open is pending', async () => {
    const gate = Promise.withResolvers<string | null>();
    mocks.readKey.mockReturnValueOnce(gate.promise);
    await mount('prefill a');
    const old = currentDraft();
    expect(old.canWrite).toBe(false);
    await act(async () => {
      await signIn('account-b');
      renderer?.update(createElement(Composer));
    });
    await act(async () => {
      gate.resolve(mocks.secure.get('persist-db-key') ?? null);
    });
    expect(currentDraft()).toMatchObject({ status: 'present', value: 'saved b' });
    await act(async () => {
      old.save('stale a');
      await old.flush();
    });
    expect(stored('account-a')).toBe('"saved a"');
    expect(stored('account-b')).toBe('"saved b"');
  });
  it('revokes a previous restoration grant after selection generation changes', async () => {
    await mount();
    const old = currentDraft();
    await act(async () => {
      renderer?.update(createElement(Composer, { selection: 1 }));
    });
    await act(async () => {
      old.save('stale selection');
      await old.flush();
      expect(await old.clear()).toBe(false);
    });
    expect(stored()).toBe('"saved a"');
  });
  it('protects MissingSQLCipher with rebuild guidance and never deletes or replaces stored bytes', async () => {
    mocks.hasCipher = false;
    const savedKey = mocks.secure.get('persist-db-key');
    await mount();
    expect(currentDraft()).toMatchObject({
      status: 'failed',
      canWrite: false,
      recovery: { status: 'protected', reason: 'missing-sqlcipher', guidance: 'rebuild' },
    });
    await act(async () => {
      await currentDraft().retry();
    });
    expect(currentDraft().status).toBe('failed');
    expect(stored()).toBe('"saved a"');
    expect(mocks.secure.get('persist-db-key')).toBe(savedKey);
    expect(mocks.removeDatabase).not.toHaveBeenCalled();
    expect(mocks.random).not.toHaveBeenCalled();
  });
  it('protects unknown open errors and permits only explicit nondestructive Retry', async () => {
    mocks.open.mockImplementationOnce(() => {
      throw new Error('opaque native failure');
    });
    await mount();
    expect(currentDraft()).toMatchObject({
      status: 'failed',
      recovery: { status: 'protected', reason: 'unknown', guidance: 'retry-without-reset' },
    });
    const store = await import('./encrypted-kv');
    await expect(store.getItem('draft:account-a', key)).rejects.toThrow('unknown');
    expect(mocks.open).toHaveBeenCalledTimes(1);
    await act(async () => {
      await currentDraft().retry();
    });
    expect(currentDraft().value).toBe('saved a');
    expect(stored()).toBe('"saved a"');
    expect(mocks.removeDatabase).not.toHaveBeenCalled();
  });
});
