/* eslint-disable max-lines -- one lease table, one set of contract tests: splitting them would scatter the one-owner-per-tab cases. */
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_TAB_WAIT_MS,
  createStorageSessionLeasePersistence,
  createTabLeaseRegistry,
} from './browser-tab-leases';
import type { PersistedTabLease, TabLeasePersistence } from './browser-tab-leases';
import type { BrowserCaller } from './browser-caller';

const panel = (conversationId: string): BrowserCaller => ({
  conversationId,
  kind: 'panel',
  panelId: 'panel-1',
});

const agent = (sessionHandle: string): BrowserCaller => ({
  controllerId: 'controller-1',
  kind: 'agent',
  sessionHandle,
});

const workflow = (runId: string): BrowserCaller => ({ kind: 'workflow', runId });

const createPersistence = (
  initial: PersistedTabLease[] = []
): TabLeasePersistence & {
  readonly stored: () => unknown;
  readonly writes: () => readonly unknown[];
} => {
  let stored: PersistedTabLease[] = initial;
  const writes: unknown[] = [];

  return {
    read: () => Promise.resolve(stored),
    stored: () => stored,
    write: leases => {
      stored = [...leases];
      writes.push(leases);
      return Promise.resolve();
    },
    writes: () => writes,
  };
};

describe('tab leases', () => {
  it('grants a free tab to each caller in turn and reports the holder', async () => {
    const leases = createTabLeaseRegistry({});
    const owner = panel('conversation-1');

    await expect(leases.acquire(7, owner)).resolves.toStrictEqual({ kind: 'granted' });
    expect(leases.holder(7)?.caller).toStrictEqual(owner);

    // The owner asking again keeps the lease; calls are serialized elsewhere.
    await expect(leases.acquire(7, owner)).resolves.toStrictEqual({ kind: 'granted' });
  });

  it('queues a different panel behind the owner instead of granting it', async () => {
    const leases = createTabLeaseRegistry({});
    const first = panel('conversation-1');
    const second = panel('conversation-2');
    const third = panel('conversation-3');

    await leases.acquire(7, first);
    const secondWait = leases.acquire(7, second);
    const thirdWait = leases.acquire(7, third);

    let secondSettled = false;
    let thirdSettled = false;
    const secondWatcher = (async (): Promise<void> => {
      await secondWait;
      secondSettled = true;
    })();
    const thirdWatcher = (async (): Promise<void> => {
      await thirdWait;
      thirdSettled = true;
    })();

    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(thirdSettled).toBe(false);
    expect(leases.holder(7)?.caller).toStrictEqual(first);

    void secondWatcher;
    void thirdWatcher;
  });

  it('grants the queue FIFO as each owner releases the tab', async () => {
    const leases = createTabLeaseRegistry({});
    const first = panel('conversation-1');
    const second = panel('conversation-2');
    const third = panel('conversation-3');

    await leases.acquire(7, first);
    const secondWait = leases.acquire(7, second);
    const thirdWait = leases.acquire(7, third);

    leases.release(7, first);
    await expect(secondWait).resolves.toStrictEqual({ kind: 'granted' });
    expect(leases.holder(7)?.caller).toStrictEqual(second);

    leases.release(7, second);
    await expect(thirdWait).resolves.toStrictEqual({ kind: 'granted' });
    expect(leases.holder(7)?.caller).toStrictEqual(third);
  });

  it('fails an agent wait with tab_busy after the agent wait window', async () => {
    vi.useFakeTimers();
    const leases = createTabLeaseRegistry({});
    const owner = panel('conversation-1');

    await leases.acquire(7, owner);

    const wait = leases.acquire(7, agent('session-1'));

    await vi.advanceTimersByTimeAsync(AGENT_TAB_WAIT_MS - 1);
    expect(leases.holder(7)?.caller).toStrictEqual(owner);

    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toStrictEqual({ kind: 'busy' });
    expect(leases.holder(7)?.caller).toStrictEqual(owner);

    vi.useRealTimers();
  });

  it('drops a timed-out agent wait from the queue so no release grants it the tab', async () => {
    vi.useFakeTimers();
    const leases = createTabLeaseRegistry({});
    const owner = panel('conversation-1');
    const later = panel('conversation-2');

    await leases.acquire(7, owner);

    const timedOut = leases.acquire(7, agent('session-1'));
    const queued = leases.acquire(7, later);

    await vi.advanceTimersByTimeAsync(AGENT_TAB_WAIT_MS);
    await expect(timedOut).resolves.toStrictEqual({ kind: 'busy' });

    // The agent that already got tab_busy must not become the holder: nothing would release it.
    leases.release(7, owner);
    await expect(queued).resolves.toStrictEqual({ kind: 'granted' });
    expect(leases.holder(7)?.caller).toStrictEqual(later);

    vi.useRealTimers();
  });

  it('does not resurrect a lease a release dropped before the first acquire', async () => {
    const persistence = createPersistence([
      { caller: panel('conversation-1'), tabId: 7, title: 'Panel' },
    ]);
    const leases = createTabLeaseRegistry({ persistence });

    // A fresh worker's first lease operation is the turn-end release, before any acquire starts the read.
    expect(leases.releaseCaller(panel('conversation-1'))).toBe(0);

    await expect(leases.acquire(7, panel('conversation-2'))).resolves.toStrictEqual({
      kind: 'granted',
    });
    expect(leases.holder(7)?.caller).toStrictEqual(panel('conversation-2'));
  });

  it("keeps another caller's stored lease when a caller that does not hold the tab releases it", async () => {
    const persistence = createPersistence([
      { caller: panel('conversation-1'), tabId: 7, title: 'Panel' },
    ]);
    const leases = createTabLeaseRegistry({ persistence });

    // A handover release names a panel that never held this tab, e.g. the settings-run path.
    leases.release(7, panel('conversation-9'));

    // The stored lease belongs to conversation-1 and must survive the read.
    await expect(leases.acquire(8, panel('conversation-2'))).resolves.toStrictEqual({
      kind: 'granted',
    });
    expect(leases.holder(7)?.caller).toStrictEqual(panel('conversation-1'));
  });

  it('does not resurrect a lease a dispose released while the initial read was in flight', async () => {
    const { promise: readLeases, resolve: resolveRead } = Promise.withResolvers<
      PersistedTabLease[] | undefined
    >();
    const leases = createTabLeaseRegistry({
      persistence: {
        read: () => readLeases,
        write: () => Promise.resolve(),
      },
    });
    const stored = { caller: agent('session-1'), tabId: 7, title: 'Price check' };

    const first = leases.acquire(7, panel('conversation-1'));
    // The worker restart's read is still pending; the agent session closes in the meantime.
    expect(leases.releaseCaller(agent('session-1'))).toBe(0);

    resolveRead([stored]);

    // The tab is free: the released lease must not come back as a phantom owner.
    await expect(first).resolves.toStrictEqual({ kind: 'granted' });
    expect(leases.holder(7)?.caller).toStrictEqual(panel('conversation-1'));
  });

  it('detaches a queued wait abort listener once the waiter is granted', async () => {
    const leases = createTabLeaseRegistry({});
    const owner = panel('conversation-1');
    const abort = new AbortController();
    const removeListener = vi.spyOn(abort.signal, 'removeEventListener');

    await leases.acquire(7, owner);
    const queued = leases.acquire(7, panel('conversation-2'), { signal: abort.signal });

    leases.release(7, owner);

    await expect(queued).resolves.toStrictEqual({ kind: 'granted' });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('never lets an agent take a tab from a panel: it waits, then reports busy', async () => {
    vi.useFakeTimers();
    const leases = createTabLeaseRegistry({});
    const owner = panel('conversation-1');

    await leases.acquire(7, owner);

    const wait = leases.acquire(7, agent('session-1'), { takeOver: true });

    await vi.advanceTimersByTimeAsync(AGENT_TAB_WAIT_MS);
    await expect(wait).resolves.toStrictEqual({ kind: 'busy' });
    expect(leases.holder(7)?.caller).toStrictEqual(owner);

    vi.useRealTimers();
  });

  it('asks a panel to confirm before it takes a tab from an agent', async () => {
    const leases = createTabLeaseRegistry({});
    const holder = agent('session-1');

    await leases.acquire(7, holder, { title: 'Price check' });

    const withoutConfirmation = await leases.acquire(7, panel('conversation-1'));

    expect(withoutConfirmation).toStrictEqual({
      holder: { caller: holder, key: 'agent:controller-1:session-1', title: 'Price check' },
      kind: 'needs_take_over',
    });
    expect(leases.holder(7)?.caller).toStrictEqual(holder);
  });

  it('grants a panel the tab after the confirmation and names the agent it took it from', async () => {
    const leases = createTabLeaseRegistry({});
    const holder = agent('session-1');
    const taker = panel('conversation-1');

    await leases.acquire(7, holder, { title: 'Price check' });

    const result = await leases.acquire(7, taker, { takeOver: true });

    expect(result).toStrictEqual({
      kind: 'granted',
      takeover: { caller: holder, key: 'agent:controller-1:session-1', title: 'Price check' },
    });
    expect(leases.holder(7)?.caller).toStrictEqual(taker);
  });

  it('does not let a panel take a tab from another panel or a workflow', async () => {
    vi.useFakeTimers();
    const leases = createTabLeaseRegistry({});

    await leases.acquire(7, workflow('run-1'));

    const wait = leases.acquire(7, panel('conversation-1'), { takeOver: true });
    let settled = false;
    const watcher = (async (): Promise<void> => {
      await wait;
      settled = true;
    })();

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(leases.holder(7)?.caller).toStrictEqual(workflow('run-1'));

    void watcher;
    vi.useRealTimers();
  });

  it('releases every tab a caller holds and drops its queued waits', async () => {
    const leases = createTabLeaseRegistry({});
    const owner = panel('conversation-1');
    const other = panel('conversation-2');

    await leases.acquire(7, owner);
    await leases.acquire(8, owner);
    const queued = leases.acquire(7, other);

    await Promise.resolve();
    expect(leases.releaseCaller(owner)).toBe(2);
    await expect(queued).resolves.toStrictEqual({ kind: 'granted' });
    expect(leases.holder(7)?.caller).toStrictEqual(other);
    expect(leases.holder(8)).toBeUndefined();
  });

  it('frees the tab and drops its queue when the tab closes', async () => {
    const leases = createTabLeaseRegistry({});
    const owner = panel('conversation-1');
    const other = panel('conversation-2');

    await leases.acquire(7, owner);
    const queued = leases.acquire(7, other);

    leases.releaseTab(7);

    await expect(queued).resolves.toStrictEqual({ kind: 'busy' });
    expect(leases.holder(7)).toBeUndefined();
  });

  it('drops a queued wait when its caller aborts', async () => {
    const leases = createTabLeaseRegistry({});
    const owner = panel('conversation-1');
    const abort = new AbortController();

    await leases.acquire(7, owner);
    const queued = leases.acquire(7, panel('conversation-2'), { signal: abort.signal });

    abort.abort();

    await expect(queued).resolves.toStrictEqual({ kind: 'busy' });
    expect(leases.holder(7)?.caller).toStrictEqual(owner);
  });

  it('restores persisted leases after a service-worker restart', async () => {
    const persistence = createPersistence([
      { caller: agent('session-1'), tabId: 7, title: 'Price check' },
    ]);
    const leases = createTabLeaseRegistry({ persistence });

    const result = await leases.acquire(7, panel('conversation-1'));

    expect(result).toStrictEqual({
      holder: {
        caller: agent('session-1'),
        key: 'agent:controller-1:session-1',
        title: 'Price check',
      },
      kind: 'needs_take_over',
    });
  });

  it('persists holder changes and nothing about waiters', async () => {
    const persistence = createPersistence();
    const leases = createTabLeaseRegistry({ persistence });
    const owner = panel('conversation-1');

    await leases.acquire(7, owner, { title: 'Panel' });
    await leases.flush();

    expect(persistence.stored()).toStrictEqual([{ caller: owner, tabId: 7, title: 'Panel' }]);

    leases.release(7, owner);
    await leases.flush();

    expect(persistence.stored()).toStrictEqual([]);
  });

  it('ignores a malformed persisted record instead of blocking the tab', async () => {
    const leases = createTabLeaseRegistry({
      persistence: createStorageSessionLeasePersistence({
        getItem: () => [{ nonsense: true }],
        setItem: () => Promise.resolve(),
      }),
    });

    await expect(leases.acquire(7, panel('conversation-1'))).resolves.toStrictEqual({
      kind: 'granted',
    });
  });
});
