import { describe, expect, it, vi } from 'vitest';

import { createPartSubscriptions } from '@/components/agents/part-subscriptions';

describe('createPartSubscriptions', () => {
  it('notifies only the listeners registered for the changed part', () => {
    const subscriptions = createPartSubscriptions();
    const listenerA = vi.fn<() => void>();
    const listenerB = vi.fn<() => void>();
    subscriptions.subscribe('part-a', listenerA);
    subscriptions.subscribe('part-b', listenerB);

    subscriptions.notify('part-a');

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('notifies every registered part on a reset', () => {
    const subscriptions = createPartSubscriptions();
    const listenerA = vi.fn<() => void>();
    const listenerB = vi.fn<() => void>();
    subscriptions.subscribe('part-a', listenerA);
    subscriptions.subscribe('part-b', listenerB);

    subscriptions.notifyAll();

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
  });

  it('delivers one notification per part to every listener of that part', () => {
    const subscriptions = createPartSubscriptions();
    const first = vi.fn<() => void>();
    const second = vi.fn<() => void>();
    subscriptions.subscribe('part-a', first);
    subscriptions.subscribe('part-a', second);

    subscriptions.notify('part-a');

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe and keeps the other listeners of that part', () => {
    const subscriptions = createPartSubscriptions();
    const removed = vi.fn<() => void>();
    const kept = vi.fn<() => void>();
    const unsubscribe = subscriptions.subscribe('part-a', removed);
    subscriptions.subscribe('part-a', kept);

    unsubscribe();
    subscriptions.notify('part-a');

    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('does not wake a part nobody subscribes to', () => {
    const subscriptions = createPartSubscriptions();
    const listener = vi.fn<() => void>();
    subscriptions.subscribe('part-a', listener);

    subscriptions.notify('part-unknown');

    expect(listener).not.toHaveBeenCalled();
  });

  it('supports re-subscribing a part after its last listener leaves', () => {
    const subscriptions = createPartSubscriptions();
    const first = vi.fn<() => void>();
    subscriptions.subscribe('part-a', first)();
    const late = vi.fn<() => void>();
    subscriptions.subscribe('part-a', late);

    subscriptions.notify('part-a');

    expect(first).not.toHaveBeenCalled();
    expect(late).toHaveBeenCalledTimes(1);
  });
});
