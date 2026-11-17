import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TAB_WAIT_MS, createTabLeaseRegistry } from './browser-tab-leases';
import type { TabLeasePersistence } from './browser-tab-leases';
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

const createPersistence = (initial: unknown = []): TabLeasePersistence & {
  readonly stored: () => unknown;
  readonly writes: () => readonly unknown[];
} => {
  let stored: unknown = initial;
  const writes: unknown[] = [];

  return {
    read: async () => stored,
    stored: () => stored,
    write: async leases => {
      stored = leases;
      writes.push(leases);
    },
    writes: () => writes,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('tab leases', () => {
  it('grants a free tab to each caller in turn and reports the holder', async () => {
    const leases = createTabLeaseRegistry({});
    const owner = panel('conversation-1');

    await expect(leases.acquire(7, owner)).resolves.toStrictEqual({ kind: 'granted' });
    expect(leases.holder(7)?.caller).toStrictEqual(owner);

    // The owner asking again keeps the lease; calls are serialized elsewhere.
    await expect(leases.acquire(7, owner)).resolves.toStrictEqual({ kind: 'granted' });
  });

  it('queues a different panel FIFO and grants it when the owner releases', async () => {
    const leases = createTabLeaseRegistry({});
    const first = panel('conversation-1');
    const second = panel('conversation-2');
    const third = panel('conversation-3');

    await leases.acquire(7, first);
    const secondWait = leases.acquire(7, second);
    const thirdWait = leases.acquire(7, third);

    let secondSettled = false;
    let thirdSettled = false;
    void secondWait.then(() => {
      secondSettled = true;
    });
    void thirdWait.then(() => {
      thirdSettled = true;
    });

    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(thirdSettled).toBe(false);

    leases.release(7, first);
    await expect(secondWait).resolves.toStrictEqual({ kind: 'granted' });
    expect(leases.holder(7)?.caller).toStrictEqual(second);
    expect(thirdSettled).toBe(false);

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
    void wait.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(leases.holder(7)?.caller).toStrictEqual(workflow('run-1'));
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

    expect(persistence.stored()).toStrictEqual([
      { caller: owner, tabId: 7, title: 'Panel' },
    ]);

    leases.release(7, owner);
    await leases.flush();

    expect(persistence.stored()).toStrictEqual([]);
  });

  it('ignores a malformed persisted record instead of blocking the tab', async () => {
    const persistence = createPersistence([{ nonsense: true }]);
    const leases = createTabLeaseRegistry({ persistence });

    await expect(leases.acquire(7, panel('conversation-1'))).resolves.toStrictEqual({
      kind: 'granted',
    });
  });
});
