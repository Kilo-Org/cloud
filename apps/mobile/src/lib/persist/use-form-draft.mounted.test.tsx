/* eslint-disable max-lines -- one hook's whole contract: the fenced load, the held write, its replay, and the clear-beats-save rule share one fake store */
import { describe, expect, it, vi } from 'vitest';

import { type FormDraftState, useFormDraft } from '@/lib/persist/use-form-draft';
import { act } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { createElement } from 'react';

// The real persist modules open the encrypted SQLite store, which this Node
// project cannot import: the fake below records what the hook wrote.
const store = vi.hoisted(() => {
  const saved: { userId: string; entityKey: string; value: unknown }[] = [];
  const cleared: { userId: string; entityKey: string }[] = [];
  const loaded: { userId: string; entityKey: string }[] = [];
  let pending: { promise: Promise<unknown>; resolve: (value: unknown) => void } | null = null;
  return {
    saved,
    cleared,
    loaded,
    saveDraft: vi.fn((userId: string, entityKey: string, value: unknown) => {
      saved.push({ userId, entityKey, value });
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- the fake answers synchronously, like an in-memory store
    clearDraft: vi.fn((userId: string, entityKey: string) => {
      cleared.push({ userId, entityKey });
      return Promise.resolve(true);
    }),
    loadDraft: vi.fn((userId: string, entityKey: string) => {
      loaded.push({ userId, entityKey });
      if (pending === null) {
        return Promise.resolve(null);
      }
      const gate = pending;
      pending = null;
      return gate.promise;
    }),
    /** Hold the next load open; the answer hands back the release. */
    holdNextLoad() {
      const { promise, resolve } = Promise.withResolvers<unknown>();
      pending = { promise, resolve };
      return (value: unknown) => {
        resolve(value);
      };
    },
    reset() {
      saved.length = 0;
      cleared.length = 0;
      loaded.length = 0;
      pending = null;
      this.saveDraft.mockClear();
      this.clearDraft.mockClear();
      this.loadDraft.mockClear();
    },
  };
});

vi.mock('@/lib/persist/drafts', () => ({
  saveDraft: store.saveDraft,
  clearDraft: store.clearDraft,
  flushDraft: vi.fn(() => Promise.resolve(undefined)),
  loadDraftEntry: vi.fn(async (userId: string, entityKey: string) => {
    const value: unknown = await store.loadDraft(userId, entityKey);
    return value === null ? null : { value, updatedAt: 1 };
  }),
  isStringDraft: (value: unknown): value is string => typeof value === 'string',
}));

vi.mock('@/lib/persist/use-draft-flush', () => ({ useDraftFlushOnBackground: () => undefined }));

type Draft = { name: string };

function isDraft(value: unknown): value is Draft {
  return typeof value === 'object' && value !== null && 'name' in value;
}

/** Mount the hook and expose its latest state. */
async function mountDraft() {
  const latest: { state: FormDraftState<Draft> | null } = { state: null };
  function Harness() {
    const state = useFormDraft<Draft>({
      userId: 'u1',
      isIdentityLoading: false,
      entityKey: 'org-mode-form:o1:new',
      validate: isDraft,
    });
    latest.state = state;
    return null;
  }
  await renderWithProviders(createElement(Harness));
  return latest;
}

describe('useFormDraft writes', () => {
  it('writes a save made before the stored draft answered, so a flush keeps it', async () => {
    store.reset();
    const land = store.holdNextLoad();
    const latest = await mountDraft();

    // The load is still in flight: the form is on screen and takes an edit.
    expect(latest.state?.kind).toBe('loading');
    act(() => {
      latest.state?.save({ name: 'typed early' });
    });

    // It reached the store's own queue at once, which is exactly what the
    // reload's flush drains, so a reload now still keeps the keystroke.
    expect(store.saveDraft).toHaveBeenCalledWith('u1', 'org-mode-form:o1:new', {
      name: 'typed early',
    });

    await act(async () => {
      land(null);
      await Promise.resolve();
    });

    // The load settling does not write it a second time.
    expect(store.saveDraft).toHaveBeenCalledTimes(1);
  });

  it('writes a clear made before the stored draft answered', async () => {
    store.reset();
    const land = store.holdNextLoad();
    const latest = await mountDraft();

    act(() => {
      latest.state?.clear();
    });
    expect(store.cleared).toEqual([{ userId: 'u1', entityKey: 'org-mode-form:o1:new' }]);

    await act(async () => {
      land(null);
      await Promise.resolve();
    });

    expect(store.cleared).toHaveLength(1);
  });

  it('writes a save made after the stored draft answered', async () => {
    store.reset();
    const latest = await mountDraft();
    await waitFor(() => latest.state?.kind === 'ready');

    act(() => {
      latest.state?.save({ name: 'typed late' });
    });

    expect(store.saveDraft).toHaveBeenCalledWith('u1', 'org-mode-form:o1:new', {
      name: 'typed late',
    });
  });
});
