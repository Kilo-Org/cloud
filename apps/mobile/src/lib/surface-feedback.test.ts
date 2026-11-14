import { describe, expect, it } from 'vitest';

import { createSurfaceFeedbackStore } from '@/lib/surface-feedback';

type Failure =
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'terminal'; readonly message: string };

function createStore() {
  return createSurfaceFeedbackStore<'a' | 'b', Failure>();
}

describe('createSurfaceFeedbackStore', () => {
  it('reads a key it never admitted as idle, storing nothing', () => {
    const store = createStore();
    expect(store.getSnapshot().states.has('a')).toBe(false);
    expect(store.getSnapshot().pendingKeys).toEqual([]);
  });

  it('admits one attempt per key and marks it pending in admission order', () => {
    const store = createStore();
    const first = store.begin('a');
    store.begin('b');
    expect(first).not.toBeNull();
    expect(store.getSnapshot().pendingKeys).toEqual(['a', 'b']);
    expect(store.getSnapshot().states.get('a')).toEqual({ status: 'pending' });
  });

  it('re-admits a settled key at the end of the admission order', () => {
    const store = createStore();
    store.begin('a')?.fail({ kind: 'terminal', message: 'first' });
    store.begin('b');
    store.begin('a');
    expect(store.getSnapshot().pendingKeys).toEqual(['b', 'a']);
  });

  it('refuses a second admission while the key is pending and keeps the first token', () => {
    const store = createStore();
    const first = store.begin('a');
    expect(store.begin('a')).toBeNull();
    expect(first?.succeed()).toBe(true);
    expect(store.getSnapshot().states.get('a')).toEqual({ status: 'succeeded' });
  });

  it('lets a failed attempt settle once and publishes the failure it was handed', () => {
    const store = createStore();
    const attempt = store.begin('a');
    const failure = { kind: 'retryable', message: 'Could not post' } as const;
    expect(attempt?.fail(failure)).toBe(true);
    expect(store.getSnapshot().states.get('a')).toEqual({ status: 'failed', failure });
  });

  it('returns false and notifies nobody on a double settlement', () => {
    const store = createStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    const attempt = store.begin('a');
    expect(attempt?.succeed()).toBe(true);
    notified = 0;
    expect(attempt?.fail({ kind: 'terminal', message: 'late' })).toBe(false);
    expect(notified).toBe(0);
    expect(store.getSnapshot().states.get('a')).toEqual({ status: 'succeeded' });
  });

  it('abandons an attempt by deleting the entry so the key reads idle', () => {
    const store = createStore();
    const attempt = store.begin('a');
    expect(attempt?.abandon()).toBe(true);
    expect(store.getSnapshot().states.has('a')).toBe(false);
    expect(store.getSnapshot().pendingKeys).toEqual([]);
    expect(attempt?.succeed()).toBe(false);
  });

  it('reset forgets the key and kills the token it was holding', () => {
    const store = createStore();
    const attempt = store.begin('a');
    store.reset('a');
    expect(store.getSnapshot().states.has('a')).toBe(false);
    expect(attempt?.fail({ kind: 'terminal', message: 'late' })).toBe(false);
    expect(store.getSnapshot().states.has('a')).toBe(false);
  });

  it('clearWhere retires only a matching failure, leaving a pending attempt admitted', () => {
    const store = createStore();
    const pending = store.begin('a');
    store.clearWhere('a', () => true);
    expect(store.getSnapshot().states.get('a')).toEqual({ status: 'pending' });
    expect(pending?.abandon()).toBe(true);

    const failed = store.begin('a');
    failed?.fail({ kind: 'terminal', message: 'gone' });
    store.clearWhere('a', failure => failure.kind === 'retryable');
    expect(store.getSnapshot().states.get('a')).toEqual({
      status: 'failed',
      failure: { kind: 'terminal', message: 'gone' },
    });
    store.clearWhere('a', failure => failure.kind === 'terminal');
    expect(store.getSnapshot().states.has('a')).toBe(false);
    expect(failed?.succeed()).toBe(false);
  });

  it('never resurrects a deleted token for a later entry on the same key', () => {
    const store = createStore();
    const stale = store.begin('a');
    store.reset('a');
    const current = store.begin('a');
    expect(stale?.succeed()).toBe(false);
    expect(store.getSnapshot().states.get('a')).toEqual({ status: 'pending' });
    expect(current?.succeed()).toBe(true);
  });

  it('invalidateAll forgets every key and kills every token', () => {
    const store = createStore();
    const a = store.begin('a');
    const b = store.begin('b');
    store.invalidateAll();
    expect(store.getSnapshot().states.size).toBe(0);
    expect(a?.succeed()).toBe(false);
    expect(b?.abandon()).toBe(false);
  });

  it('keeps one snapshot object until something changes', () => {
    const store = createStore();
    const attempt = store.begin('a');
    attempt?.succeed();
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.clearWhere('a', () => false);
    expect(store.getSnapshot()).toBe(first);
    store.reset('a');
    expect(store.getSnapshot()).not.toBe(first);
  });

  it('notifies once per mutation and stops after unsubscribe', () => {
    const store = createStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    const attempt = store.begin('a');
    attempt?.succeed();
    expect(notified).toBe(2);
    unsubscribe();
    store.reset('a');
    expect(notified).toBe(2);
  });
});
