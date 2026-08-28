/* eslint-disable max-lines -- legacy restoration and captured cleanup share the same KV and mounted hook harness */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/lib/persist/cache-persistence-mount.test.ts */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake KV factories settle without await because they resolve immediately */
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The drafts module imports the native encrypted-kv chain; the fake below is
// an in-memory Map-backed KV mirroring the real upsert/list semantics (same
// harness as drafts.test.ts).
const kvStore = new Map<string, { scope: string; k: string; v: string; updatedAt: number }>();
let nextUpdatedAt = 1;

const kvMock = vi.hoisted(() => ({
  getItem: vi.fn(async (_scope: string, _k: string): Promise<string | null> => null),
  setItem: vi.fn(async (_scope: string, _k: string, _v: string): Promise<void> => undefined),
  removeItem: vi.fn(async (_scope: string, _k: string): Promise<void> => undefined),
  listEntries: vi.fn(async (_scope: string): Promise<{ k: string; updatedAt: number }[]> => []),
}));

vi.mock('@/lib/persist/encrypted-kv', () => kvMock);

vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
}));

/* eslint-disable import/first */
import { flushDraft, isMergeDraft, prMergeDraftKey, saveDraft } from './drafts';
import { useFencedDraftLoad, useRemoteSpawnDraftCleanup } from './use-draft-load';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
/* eslint-enable import/first */

function storageKey(scope: string, k: string): string {
  return `${scope}\u0000${k}`;
}

function seedStoredValue(scope: string, k: string, v: string): void {
  kvStore.set(storageKey(scope, k), { scope, k, v, updatedAt: nextUpdatedAt });
  nextUpdatedAt += 1;
}

beforeEach(() => {
  vi.clearAllMocks();
  kvStore.clear();
  nextUpdatedAt = 1;
  kvMock.getItem.mockImplementation(
    async (scope, k) => kvStore.get(storageKey(scope, k))?.v ?? null
  );
  kvMock.setItem.mockImplementation(async (scope, k, v) => {
    kvStore.set(storageKey(scope, k), { scope, k, v, updatedAt: nextUpdatedAt });
    nextUpdatedAt += 1;
  });
  kvMock.removeItem.mockImplementation(async (scope, k) => {
    kvStore.delete(storageKey(scope, k));
  });
  kvMock.listEntries.mockImplementation(async scope =>
    [...kvStore.values()]
      .filter(entry => entry.scope === scope)
      .toSorted((a, b) => a.updatedAt - b.updatedAt)
      .map(entry => ({ k: entry.k, updatedAt: entry.updatedAt }))
  );
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

type MergeDraft = { title: string; message: string };

function MergeDraftHarness({
  userId,
  entityKey,
  onRender,
}: {
  userId: string | undefined;
  entityKey: string;
  onRender: (state: { settled: boolean; value: MergeDraft | null }) => void;
}) {
  const state = useFencedDraftLoad<MergeDraft>({
    userId,
    isIdentityLoading: false,
    entityKey,
    validate: isMergeDraft,
  });
  onRender(state);
  return null;
}

function StringDraftHarness({
  userId,
  entityKey,
  onRender,
}: {
  userId: string | undefined;
  entityKey: string;
  onRender: (state: { settled: boolean; value: string | null }) => void;
}) {
  const state = useFencedDraftLoad({ userId, isIdentityLoading: false, entityKey });
  onRender(state);
  return null;
}

function mountMergeHarness(
  userId: string,
  entityKey: string,
  renders: { settled: boolean; value: MergeDraft | null }[]
): TestRenderer.ReactTestRenderer {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  act(() => {
    rendererRef.current = TestRenderer.create(
      React.createElement(MergeDraftHarness, {
        userId,
        entityKey,
        onRender: state => {
          renders.push(state);
        },
      })
    );
  });
  if (!rendererRef.current) {
    throw new Error('renderer not created');
  }
  return rendererRef.current;
}

describe('useFencedDraftLoad generic draft shape', () => {
  it('loads an object draft with a validate guard', async () => {
    const key = prMergeDraftKey('acme', 'kilo', 42);
    seedStoredValue('draft:u1', key, '{"title":"T","message":"M"}');
    const renders: { settled: boolean; value: MergeDraft | null }[] = [];
    act(() => {
      TestRenderer.create(
        React.createElement(MergeDraftHarness, {
          userId: 'u1',
          entityKey: key,
          onRender: state => {
            renders.push(state);
          },
        })
      );
    });
    await flushMicrotasks();
    expect(renders.at(-1)).toEqual({ settled: true, value: { title: 'T', message: 'M' } });
  });

  it('loads a string draft with no validate argument', async () => {
    seedStoredValue('draft:u1', 'agent-composer:new', '"hello"');
    const renders: { settled: boolean; value: string | null }[] = [];
    act(() => {
      TestRenderer.create(
        React.createElement(StringDraftHarness, {
          userId: 'u1',
          entityKey: 'agent-composer:new',
          onRender: state => {
            renders.push(state);
          },
        })
      );
    });
    await flushMicrotasks();
    expect(renders.at(-1)).toEqual({ settled: true, value: 'hello' });
  });

  it('loads null when a stored value fails the validate guard', async () => {
    const key = prMergeDraftKey('acme', 'kilo', 42);
    seedStoredValue('draft:u1', key, '"not-an-object"');
    const renders: { settled: boolean; value: MergeDraft | null }[] = [];
    act(() => {
      TestRenderer.create(
        React.createElement(MergeDraftHarness, {
          userId: 'u1',
          entityKey: key,
          onRender: state => {
            renders.push(state);
          },
        })
      );
    });
    await flushMicrotasks();
    expect(renders.at(-1)).toEqual({ settled: true, value: null });
  });

  it('returns the not-settled state on the entity-change render, never the stale settled value', async () => {
    const keyA = prMergeDraftKey('acme', 'kilo', 42);
    const keyB = prMergeDraftKey('acme', 'kilo', 43);
    seedStoredValue('draft:u1', keyA, '{"title":"T","message":"M"}');
    const renders: { settled: boolean; value: MergeDraft | null }[] = [];
    const renderer = mountMergeHarness('u1', keyA, renders);
    await flushMicrotasks();
    // The first generation settled with the stored value.
    expect(renders.at(-1)).toEqual({ settled: true, value: { title: 'T', message: 'M' } });
    renders.length = 0;

    // Move to a new entity: the very next render must be not-settled, not the
    // stale keyA value (which a surface would otherwise seed under keyB).
    act(() => {
      renderer.update(
        React.createElement(MergeDraftHarness, {
          userId: 'u1',
          entityKey: keyB,
          onRender: state => {
            renders.push(state);
          },
        })
      );
    });
    expect(renders[0]).toEqual({ settled: false, value: null });
  });

  it('returns the not-settled state on the identity-change render, never the stale settled value', async () => {
    const key = prMergeDraftKey('acme', 'kilo', 42);
    seedStoredValue('draft:u1', key, '{"title":"T","message":"M"}');
    const renders: { settled: boolean; value: MergeDraft | null }[] = [];
    const renderer = mountMergeHarness('u1', key, renders);
    await flushMicrotasks();
    expect(renders.at(-1)).toEqual({ settled: true, value: { title: 'T', message: 'M' } });
    renders.length = 0;

    act(() => {
      renderer.update(
        React.createElement(MergeDraftHarness, {
          userId: 'u2',
          entityKey: key,
          onRender: state => {
            renders.push(state);
          },
        })
      );
    });
    expect(renders[0]).toEqual({ settled: false, value: null });
  });

  it('does not publish a stale in-flight load after the identity changes', async () => {
    const key = prMergeDraftKey('acme', 'kilo', 42);
    seedStoredValue('draft:u1', key, '{"title":"T","message":"M"}');

    // Hold identity A's read open so its load is still in flight when the
    // identity switches to B.
    const readGate: { release: ((v: string | null) => void) | null } = { release: null };
    const readHeld = new Promise<string | null>(resolve => {
      readGate.release = resolve;
    });
    kvMock.getItem.mockImplementationOnce(async () => readHeld);

    const renders: { settled: boolean; value: MergeDraft | null }[] = [];
    const renderer = mountMergeHarness('u1', key, renders);
    // A's load is pending on the deferred read.
    expect(renders.at(-1)).toEqual({ settled: false, value: null });

    // A's read resolves, then the identity switches before the load's
    // generation check runs. The stale load must not publish A's value.
    readGate.release?.('{"title":"T","message":"M"}');

    act(() => {
      renderer.update(
        React.createElement(MergeDraftHarness, {
          userId: 'u2',
          entityKey: key,
          onRender: state => {
            renders.push(state);
          },
        })
      );
    });

    await flushMicrotasks();

    // B has no stored value. The stale A load must never publish A's value.
    expect(renders.at(-1)).toEqual({ settled: true, value: null });
  });
});

const cleanupControl: { current: ReturnType<typeof useRemoteSpawnDraftCleanup> | null } = {
  current: null,
};
function RemoteCleanupHarness({
  entityKey,
  isCurrent,
}: {
  entityKey: string;
  isCurrent: () => boolean;
}) {
  cleanupControl.current = useRemoteSpawnDraftCleanup({
    userId: 'u1',
    entityKey,
    isCurrent: () => isCurrent(),
  });
  return null;
}
async function mountCleanup() {
  const context = await import('@/lib/context-scope');
  const keys = await import('./scoped-draft-keys');
  context.beginAuthenticatedOwner();
  context.confirmAuthenticatedOwner(context.getAuthenticatedOwner(), 'u1');
  const owner = context.getAuthenticatedOwner();
  const isCurrent = () => context.isAuthenticatedOwner(owner);
  const entityKey = keys.scopedDraftKey(context.contextScope('personal'), { kind: 'new-session' });
  const rendererRef: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  await act(async () => {
    rendererRef.current = TestRenderer.create(
      React.createElement(RemoteCleanupHarness, { entityKey, isCurrent })
    );
  });
  if (!rendererRef.current) {
    throw new Error('Cleanup harness did not mount');
  }
  return { renderer: rendererRef.current, entityKey, isCurrent };
}
describe('captured remote-spawn draft cleanup', () => {
  it('clears the captured tagged key only on leave, not when its guard callback changes', async () => {
    const { renderer, entityKey, isCurrent } = await mountCleanup();
    seedStoredValue('draft:u1', entityKey, '"captured"');
    seedStoredValue('draft:u1', 'agent-composer:new', '"legacy fallback"');
    cleanupControl.current?.markRemoteSpawnAttempted();
    await act(async () => {
      renderer.update(React.createElement(RemoteCleanupHarness, { entityKey, isCurrent }));
    });
    expect(kvStore.get(storageKey('draft:u1', entityKey))?.v).toBe('"captured"');
    await act(async () => {
      renderer.unmount();
    });
    await flushMicrotasks();
    expect(kvStore.has(storageKey('draft:u1', entityKey))).toBe(false);
    expect(kvStore.get(storageKey('draft:u1', 'agent-composer:new'))?.v).toBe('"legacy fallback"');
  });
  it('flushes the exact captured key on a normal leave', async () => {
    const { renderer, entityKey, isCurrent } = await mountCleanup();
    saveDraft('u1', entityKey, 'unsent', isCurrent);
    await act(async () => {
      renderer.unmount();
    });
    await flushMicrotasks();
    expect(kvStore.get(storageKey('draft:u1', entityKey))?.v).toBe('"unsent"');
  });
  it('keeps the old draft when auth changes before a recorded spawn leaves', async () => {
    const { renderer, entityKey, isCurrent } = await mountCleanup();
    saveDraft('u1', entityKey, 'preserved', isCurrent);
    await flushDraft('u1', entityKey, isCurrent);
    cleanupControl.current?.markRemoteSpawnAttempted();
    bumpAuthEpoch();
    await act(async () => {
      renderer.unmount();
    });
    await flushMicrotasks();
    expect(kvStore.get(storageKey('draft:u1', entityKey))?.v).toBe('"preserved"');
  });
});
