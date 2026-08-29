/* eslint-disable import/no-nodejs-modules, jest/no-hooks, jest/no-conditional-in-test, max-lines, require-await, typescript/require-await, typescript/no-unsafe-assignment, unicorn/no-await-expression-member, promise/prefer-await-to-callbacks -- Native scheduling fixtures implement asynchronous APIs and storage subscriptions; matchers describe observable state. */
import { locks as nativeLocks } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_EXECUTION_LOCK,
  BROWSER_EXECUTION_SAFETY_KEY,
  createBrowserExecutionCoordinator,
} from './browser-execution-lock';
import type {
  BrowserAdmission,
  BrowserExecutionLease,
  BrowserLockStorage,
} from './browser-execution-lock';

const locks = nativeLocks as LockManager;
const leases = new Set<BrowserExecutionLease>();
const admitted = (admission: BrowserAdmission): BrowserExecutionLease => {
  if (!admission.admitted) {
    throw new Error(admission.reason);
  }
  leases.add(admission.lease);
  return admission.lease;
};
const profile = (supportsLocks = true) => {
  const values = new Map<string, unknown>();
  const watchers = new Set<() => void>();
  const storageArea: BrowserLockStorage = {
    getItem: key => values.get(key),
    setItem: (key, value) => {
      values.set(key, structuredClone(value));
      for (const watcher of watchers) {
        watcher();
      }
    },
    watch: (_key, callback) => {
      watchers.add(callback);
      return () => {
        watchers.delete(callback);
      };
    },
  };
  return {
    panel: () =>
      createBrowserExecutionCoordinator({ locks: supportsLocks ? locks : undefined, storageArea }),
    storageArea,
    values,
  };
};

describe('profile browser execution locks', () => {
  afterEach(async () => {
    await Promise.all([...leases].map(lease => lease.release()));
    leases.clear();
  });

  it('admits shared local runs in separate panels without sharing provider ownership', async () => {
    const state = profile();
    const first = state.panel();
    const second = state.panel();
    const owner = admitted(await first.acquireProviderOwner());
    expect((await second.acquireProviderOwner()).admitted).toBe(false);
    const one = admitted(await first.acquireLocal());
    const two = admitted(await second.acquireLocal());
    const values = await Promise.all([
      one.run(async () => 'first tab'),
      two.run(async () => 'second tab'),
    ]);
    expect(values).toStrictEqual(['first tab', 'second tab']);
    await first.refresh();
    expect(first.getSnapshot()).toMatchObject({
      delegated: 'idle',
      localRuns: 2,
      providerOwned: true,
    });
    await owner.release();
    admitted(await second.acquireProviderOwner());
  });

  it('rejects new local work while delegation waits and while it runs', async () => {
    const state = profile();
    const localPanel = state.panel();
    const providerPanel = state.panel();
    const local = admitted(await localPanel.acquireLocal());
    const provider = admitted(await providerPanel.acquireProviderOwner());
    const pending = providerPanel.acquireDelegated(
      provider,
      'parent-a',
      new AbortController().signal
    );
    await vi.waitFor(async () => {
      expect(
        (await locks.query()).pending?.some(lock => lock.name === BROWSER_EXECUTION_LOCK)
      ).toBe(true);
    });
    const blocked = await localPanel.acquireLocal();
    expect(blocked).toMatchObject({
      admitted: false,
      reason: expect.stringContaining('CLI session parent-a'),
    });
    await local.release();
    const delegated = admitted(await pending);
    expect((await localPanel.acquireLocal()).admitted).toBe(false);
    await delegated.release();
    admitted(await localPanel.acquireLocal());
  });

  it('holds the execution lock until an issued action unwinds after release is requested', async () => {
    const panel = profile().panel();
    const local = admitted(await panel.acquireLocal());
    const provider = admitted(await panel.acquireProviderOwner());
    const action = Promise.withResolvers<void>();
    const events: string[] = [];
    const work = local.run(async guard => {
      guard();
      events.push('issued');
      await action.promise;
      events.push('unwound');
    });
    const releasing = local.release();
    const pending = panel.acquireDelegated(provider, 'parent-a', new AbortController().signal);
    try {
      await vi.waitFor(async () => {
        expect(
          (await locks.query()).pending?.some(lock => lock.name === BROWSER_EXECUTION_LOCK)
        ).toBe(true);
      });
      expect(events).toStrictEqual(['issued']);
      expect(() => {
        local.guard();
      }).toThrow('execution_lease_lost');
    } finally {
      action.resolve();
    }
    await Promise.all([work, releasing]);
    const delegated = admitted(await pending);
    await delegated.run(async () => {
      events.push('delegated');
    });
    expect(events).toStrictEqual(['issued', 'unwound', 'delegated']);
  });

  it('rejects a cancelled waiter and admits explicit local work after native drainage', async () => {
    const panel = profile().panel();
    const local = admitted(await panel.acquireLocal());
    const provider = admitted(await panel.acquireProviderOwner());
    const abort = new AbortController();
    const waiting = panel.acquireDelegated(provider, 'parent-a', abort.signal);
    await vi.waitFor(async () => {
      expect((await locks.query()).pending).toHaveLength(1);
    });
    abort.abort();
    expect((await waiting).admitted).toBe(false);
    await expect(local.run(async () => 'existing local work')).resolves.toBe('existing local work');
    // Node 24 retains the cancelled native waiter until shared work drains and its scheduler advances.
    // Never hide a native pending exclusive lock in product code; browser cancellation proof belongs to a13.
    await local.release();
    await vi.waitFor(async () => {
      expect((await locks.query()).pending).toHaveLength(0);
    });
    const next = admitted(await panel.acquireLocal());
    await expect(next.run(async () => 'explicit submission')).resolves.toBe('explicit submission');
  });

  it('persists quarantine before release and blocks fresh panels until closed-tab recovery', async () => {
    const state = profile();
    const panel = state.panel();
    const local = admitted(await panel.acquireLocal());
    await local.quarantine(7);
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      tabIds: [7],
      version: 1,
    });
    await local.release();
    const reloaded = state.panel();
    const provider = admitted(await reloaded.acquireProviderOwner());
    expect({
      delegated: (
        await reloaded.acquireDelegated(provider, 'parent-b', new AbortController().signal)
      ).admitted,
      local: (await reloaded.acquireLocal()).admitted,
    }).toStrictEqual({ delegated: false, local: false });
    await expect(reloaded.recover(async () => [7, 8])).resolves.toMatchObject({ recovered: false });
    await expect(reloaded.recover(async () => [8])).resolves.toMatchObject({ recovered: true });
    const resumed = admitted(await panel.acquireLocal());
    await expect(resumed.run(async () => 'explicit new work')).resolves.toBe('explicit new work');
  });

  it('requires every shared action to drain before recovery', async () => {
    const state = profile();
    const first = state.panel();
    const second = state.panel();
    const one = admitted(await first.acquireLocal());
    const two = admitted(await second.acquireLocal());
    await one.quarantine(7);
    await one.release();
    await expect(first.recover(async () => [])).resolves.toMatchObject({
      reason: expect.stringContaining('unwinding'),
      recovered: false,
    });
    await two.release();
    await expect(first.recover(async () => [])).resolves.toMatchObject({ recovered: true });
  });

  it('does not release while the quarantine write is pending', async () => {
    const state = profile();
    const write = state.storageArea.setItem;
    const persist = Promise.withResolvers<void>();
    state.storageArea.setItem = async (key, value) => {
      if (key === BROWSER_EXECUTION_SAFETY_KEY) {
        await persist.promise;
      }
      await write(key, value);
    };
    const panel = state.panel();
    const local = admitted(await panel.acquireLocal());
    const quarantine = local.quarantine(7);
    const releasing = local.release();
    try {
      await vi.waitFor(async () => {
        expect((await locks.query()).held?.some(lock => lock.name === BROWSER_EXECUTION_LOCK)).toBe(
          true
        );
      });
      await expect(panel.recover(async () => [])).resolves.toMatchObject({ recovered: false });
      expect((await state.panel().acquireLocal()).admitted).toBe(false);
    } finally {
      persist.resolve();
    }
    await Promise.all([quarantine, releasing]);
    expect((await state.panel().acquireLocal()).admitted).toBe(false);
  });

  it('merges uncertain tabs from concurrent local panels', async () => {
    const state = profile();
    const one = admitted(await state.panel().acquireLocal());
    const two = admitted(await state.panel().acquireLocal());
    await Promise.all([one.quarantine(7), two.quarantine(8)]);
    await Promise.all([one.release(), two.release()]);
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({
      tabIds: expect.arrayContaining([7, 8]),
    });
    await expect(state.panel().recover(async () => [8])).resolves.toMatchObject({
      recovered: false,
    });
  });

  it('keeps the lock after a failed fence write instead of granting delegation', async () => {
    const state = profile();
    const panel = state.panel();
    const local = admitted(await panel.acquireLocal());
    const write = state.storageArea.setItem;
    state.storageArea.setItem = () => {
      throw new Error('storage unavailable');
    };
    try {
      await expect(local.quarantine(7)).rejects.toThrow('storage unavailable');
      await expect(local.release()).rejects.toThrow('storage unavailable');
      await expect(panel.recover(async () => [])).resolves.toMatchObject({ recovered: false });
    } finally {
      state.storageArea.setItem = write;
      await local.quarantine(7);
      await local.release();
    }
  });

  it('recovers a discarded failed lease only after a durable fence and affected-tab closure', async () => {
    const state = profile();
    const panel = state.panel();
    const write = state.storageArea.setItem;
    state.storageArea.setItem = () => {
      throw new Error('storage unavailable');
    };
    {
      const local = admitted(await panel.acquireLocal());
      await expect(local.quarantine(7)).rejects.toThrow('storage unavailable');
      await expect(local.release()).rejects.toThrow('storage unavailable');
      leases.delete(local);
    }
    const persist = Promise.withResolvers<void>();
    let writing = false;
    state.storageArea.setItem = async (key, value) => {
      writing = true;
      await persist.promise;
      await write(key, value);
    };
    const recovering = panel.recover(async () => [7, 8]);
    try {
      await vi.waitFor(() => {
        expect(writing).toBe(true);
      });
      expect(state.values.has(BROWSER_EXECUTION_SAFETY_KEY)).toBe(false);
      expect(
        (await locks.query()).held?.filter(lock => lock.name === BROWSER_EXECUTION_LOCK)
      ).toMatchObject([{ mode: 'shared' }]);
      expect((await state.panel().acquireLocal()).admitted).toBe(false);
      await expect(panel.recover(async () => [])).resolves.toMatchObject({ recovered: false });
    } finally {
      persist.resolve();
      state.storageArea.setItem = write;
    }
    await expect(recovering).resolves.toStrictEqual({
      reason: 'Close all affected tabs before recovery.',
      recovered: false,
    });
    expect({
      admitted: (await state.panel().acquireLocal()).admitted,
      safety: state.values.get(BROWSER_EXECUTION_SAFETY_KEY),
    }).toMatchObject({ admitted: false, safety: { tabIds: [7] } });
    await expect(panel.recover(async () => [8])).resolves.toStrictEqual({
      reason: 'Browser control recovered. Submit new work explicitly.',
      recovered: true,
    });
    expect(
      (await locks.query()).held?.filter(lock => lock.name === BROWSER_EXECUTION_LOCK)
    ).toHaveLength(0);
    const next = admitted(await panel.acquireLocal());
    await expect(next.run(async () => 'explicit new work')).resolves.toBe('explicit new work');
  });

  it('keeps discarded leases fenced across repeated recovery write failures', async () => {
    const state = profile();
    const panel = state.panel();
    const otherPanel = state.panel();
    const provider = admitted(await otherPanel.acquireProviderOwner());
    const write = state.storageArea.setItem;
    state.storageArea.setItem = () => {
      throw new Error('storage unavailable');
    };
    {
      const local = admitted(await panel.acquireLocal());
      await expect(local.quarantine(7)).rejects.toThrow('storage unavailable');
      await expect(local.release()).rejects.toThrow('storage unavailable');
      leases.delete(local);
    }
    try {
      await expect(panel.recover(async () => [])).resolves.toMatchObject({
        reason: expect.stringContaining('safety state is unavailable'),
        recovered: false,
      });
      expect(state.values.has(BROWSER_EXECUTION_SAFETY_KEY)).toBe(false);
      expect(
        (await locks.query()).held?.filter(lock => lock.name === BROWSER_EXECUTION_LOCK)
      ).toMatchObject([{ mode: 'shared' }]);
      expect({
        delegated: (
          await otherPanel.acquireDelegated(provider, 'parent-b', new AbortController().signal)
        ).admitted,
        local: (await panel.acquireLocal()).admitted,
        otherLocal: (await otherPanel.acquireLocal()).admitted,
      }).toStrictEqual({ delegated: false, local: false, otherLocal: false });
      await expect(otherPanel.recover(async () => [])).resolves.toMatchObject({ recovered: false });
    } finally {
      state.storageArea.setItem = write;
      await panel.recover(async () => []);
    }
    const next = admitted(await otherPanel.acquireLocal());
    await expect(next.run(async () => 'explicit new work')).resolves.toBe('explicit new work');
  });

  it('waits for an issued action before retrying a discarded lease fence', async () => {
    const state = profile();
    const panel = state.panel();
    const write = state.storageArea.setItem;
    const action = Promise.withResolvers<void>();
    const events: string[] = [];
    const work = (async () => {
      const local = admitted(await panel.acquireLocal());
      const running = local.run(async guard => {
        guard();
        events.push('issued');
        await action.promise;
        events.push('unwound');
      });
      state.storageArea.setItem = () => {
        throw new Error('storage unavailable');
      };
      await expect(local.quarantine(7)).rejects.toThrow('storage unavailable');
      await expect(local.release()).rejects.toThrow('storage unavailable');
      leases.delete(local);
      state.storageArea.setItem = write;
      return running;
    })();
    try {
      await vi.waitFor(() => {
        expect(leases.size).toBe(0);
        expect(events).toStrictEqual(['issued']);
      });
      await expect(panel.recover(async () => [])).resolves.toMatchObject({
        reason: expect.stringContaining('unwinding'),
        recovered: false,
      });
      expect(state.values.has(BROWSER_EXECUTION_SAFETY_KEY)).toBe(false);
      expect((await state.panel().acquireLocal()).admitted).toBe(false);
    } finally {
      action.resolve();
      await work;
      state.storageArea.setItem = write;
    }
    expect(events).toStrictEqual(['issued', 'unwound']);
    await expect(panel.recover(async () => [])).resolves.toMatchObject({ recovered: true });
  });

  it('drains other panels before clearing a recovered discarded lease fence', async () => {
    const state = profile();
    const panel = state.panel();
    const otherPanel = state.panel();
    const otherLocal = admitted(await otherPanel.acquireLocal());
    const write = state.storageArea.setItem;
    state.storageArea.setItem = () => {
      throw new Error('storage unavailable');
    };
    {
      const local = admitted(await panel.acquireLocal());
      await expect(local.quarantine(7)).rejects.toThrow('storage unavailable');
      await expect(local.release()).rejects.toThrow('storage unavailable');
      leases.delete(local);
    }
    state.storageArea.setItem = write;
    await expect(otherPanel.recover(async () => [])).resolves.toMatchObject({ recovered: false });
    await expect(panel.recover(async () => [])).resolves.toMatchObject({
      reason: expect.stringContaining('unwinding'),
      recovered: false,
    });
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
    expect((await state.panel().acquireLocal()).admitted).toBe(false);
    await otherLocal.release();
    await expect(panel.recover(async () => [])).resolves.toMatchObject({ recovered: true });
  });

  it('fails closed on corrupt safety data rather than discarding the fence', async () => {
    const state = profile();
    state.values.set(BROWSER_EXECUTION_SAFETY_KEY, { tabIds: ['7'], version: 1 });
    await expect(state.panel().acquireLocal()).resolves.toMatchObject({
      admitted: false,
      reason: expect.stringContaining('safety state is unavailable'),
    });
  });

  it('preserves local operation but denies delegation when Web Locks are absent', async () => {
    const state = profile();
    const panel = createBrowserExecutionCoordinator({
      locks: undefined,
      storageArea: state.storageArea,
    });
    const local = admitted(await panel.acquireLocal());
    await expect(local.run(async () => 'local result')).resolves.toBe('local result');
    await expect(panel.acquireProviderOwner()).resolves.toMatchObject({
      admitted: false,
      reason: expect.stringContaining('does not support Web Locks'),
    });
    expect(
      (await panel.acquireDelegated(local, 'parent-a', new AbortController().signal)).admitted
    ).toBe(false);
    expect(panel.getSnapshot().delegationUnavailableReason).toContain(
      'Local browser work remains available'
    );
  });

  it('retains fallback quarantine across panels instead of claiming global drainage', async () => {
    const state = profile(false);
    const panel = state.panel();
    const otherPanel = state.panel();
    const local = admitted(await panel.acquireLocal());
    const otherLocal = admitted(await otherPanel.acquireLocal());
    const action = Promise.withResolvers<void>();
    const work = otherLocal.run(async () => action.promise);
    await local.quarantine(7);
    await local.release();
    try {
      const recoveries = await Promise.all([
        panel.recover(async () => []),
        state.panel().recover(async () => []),
      ]);
      expect(recoveries).toStrictEqual([
        { reason: expect.stringContaining('Recovery requires Web Locks'), recovered: false },
        { reason: expect.stringContaining('Recovery requires Web Locks'), recovered: false },
      ]);
      expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
      expect((await state.panel().acquireLocal()).admitted).toBe(false);
    } finally {
      action.resolve();
      await work;
      await otherLocal.release();
    }
    await expect(panel.recover(async () => [])).resolves.toMatchObject({ recovered: false });
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
  });

  it('persists a failed fallback fence without clearing it during unsupported recovery', async () => {
    const state = profile(false);
    const panel = state.panel();
    const write = state.storageArea.setItem;
    state.storageArea.setItem = () => {
      throw new Error('storage unavailable');
    };
    {
      const local = admitted(await panel.acquireLocal());
      await expect(local.quarantine(7)).rejects.toThrow('storage unavailable');
      await expect(local.release()).rejects.toThrow('storage unavailable');
      leases.delete(local);
    }
    state.storageArea.setItem = write;
    await panel.refresh();
    const { blockedReason } = panel.getSnapshot();
    await expect(panel.recover(async () => [])).resolves.toMatchObject({
      reason: expect.stringContaining('Recovery requires Web Locks'),
      recovered: false,
    });
    expect({
      admitted: (await state.panel().acquireLocal()).admitted,
      blockedReason,
      safety: state.values.get(BROWSER_EXECUTION_SAFETY_KEY),
    }).toStrictEqual({
      admitted: false,
      blockedReason: expect.stringContaining('Close all target tabs'),
      safety: { allTabs: true, tabIds: [7], version: 1 },
    });
    const reloaded = createBrowserExecutionCoordinator({ locks, storageArea: state.storageArea });
    const blocked = await reloaded.recover(async () => [42]);
    const recovered = await reloaded.recover(async () => []);
    expect({ blocked, recovered }).toMatchObject({
      blocked: { recovered: false },
      recovered: { recovered: true },
    });
  });

  it('requires all target tabs to close after competing fallback writes lose an affected tab', async () => {
    const state = profile(false);
    const first = state.panel();
    const second = state.panel();
    const one = admitted(await first.acquireLocal());
    const two = admitted(await second.acquireLocal());
    const read = state.storageArea.getItem;
    const firstRead = Promise.withResolvers<void>();
    const secondRead = Promise.withResolvers<void>();
    let reads = 0;
    state.storageArea.getItem = async key => {
      const value = read(key);
      if (key === BROWSER_EXECUTION_SAFETY_KEY) {
        reads += 1;
        await (reads === 1 ? firstRead.promise : secondRead.promise);
      }
      return value;
    };
    // Both panels capture the empty record before either write can finish.
    const firstQuarantine = one.quarantine(7);
    const secondQuarantine = two.quarantine(8);
    const records: unknown[] = [];
    try {
      firstRead.resolve();
      await firstQuarantine;
      records.push(state.values.get(BROWSER_EXECUTION_SAFETY_KEY));
      secondRead.resolve();
      await secondQuarantine;
      records.push(state.values.get(BROWSER_EXECUTION_SAFETY_KEY));
    } finally {
      firstRead.resolve();
      secondRead.resolve();
      state.storageArea.getItem = read;
      await Promise.all([firstQuarantine, secondQuarantine]);
    }
    await Promise.all([one.release(), two.release()]);

    const reloaded = createBrowserExecutionCoordinator({ locks, storageArea: state.storageArea });
    await reloaded.refresh();
    await expect(reloaded.recover(async () => [7])).resolves.toMatchObject({
      reason: expect.stringContaining('Close all target tabs'),
      recovered: false,
    });
    expect({ reads, records }).toStrictEqual({
      reads: 2,
      records: [
        { allTabs: true, tabIds: [7], version: 1 },
        { allTabs: true, tabIds: [8], version: 1 },
      ],
    });
    expect({
      admitted: (await reloaded.acquireLocal()).admitted,
      blockedReason: reloaded.getSnapshot().blockedReason,
    }).toStrictEqual({
      admitted: false,
      blockedReason: expect.stringContaining('Close all target tabs'),
    });
    await expect(reloaded.recover(async () => [])).resolves.toMatchObject({ recovered: true });
    const resumed = admitted(await first.acquireLocal());
    expect({
      result: await resumed.run(async () => 'explicit new work'),
      safety: state.values.get(BROWSER_EXECUTION_SAFETY_KEY),
    }).toStrictEqual({
      result: 'explicit new work',
      safety: { tabIds: [], version: 1 },
    });
  });

  it('preserves the all-tabs flag in native writes until explicit recovery clears it', async () => {
    const state = profile();
    const panel = state.panel();
    const native = admitted(await panel.acquireLocal());
    const fallback = createBrowserExecutionCoordinator({
      locks: undefined,
      storageArea: state.storageArea,
    });
    const local = admitted(await fallback.acquireLocal());
    await local.quarantine(7);
    await local.release();
    await native.quarantine(8);
    await native.release();
    const reloaded = state.panel();
    await expect(reloaded.recover(async () => [42])).resolves.toMatchObject({
      reason: expect.stringContaining('Close all target tabs'),
      recovered: false,
    });
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      allTabs: true,
      tabIds: [7, 8],
      version: 1,
    });
    await expect(panel.recover(async () => [])).resolves.toMatchObject({ recovered: true });
    const next = admitted(await panel.acquireLocal());
    await next.quarantine(9);
    await next.release();
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      tabIds: [9],
      version: 1,
    });
  });

  it('preserves the all-tabs flag through failed native writes, refreshes, and discarded-lease retries', async () => {
    const state = profile();
    const panel = state.panel();
    const native = admitted(await panel.acquireLocal());
    const fallback = createBrowserExecutionCoordinator({
      locks: undefined,
      storageArea: state.storageArea,
    });
    const local = admitted(await fallback.acquireLocal());
    await local.quarantine(7);
    await local.release();
    await panel.refresh();
    const write = state.storageArea.setItem;
    state.storageArea.setItem = () => {
      throw new Error('storage unavailable');
    };
    try {
      await expect(native.quarantine(8)).rejects.toThrow('storage unavailable');
      await expect(native.release()).rejects.toThrow('storage unavailable');
      leases.delete(native);
      await panel.refresh();
      expect(panel.getSnapshot().blockedReason).toContain('Close all target tabs');
    } finally {
      state.storageArea.setItem = write;
      // Recovery must retry the discarded lease before it can release the native lock.
      await panel.recover(async () => [42]);
    }
    const reloaded = state.panel();
    await expect(reloaded.recover(async () => [42])).resolves.toMatchObject({
      reason: expect.stringContaining('Close all target tabs'),
      recovered: false,
    });
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      allTabs: true,
      tabIds: [7, 8],
      version: 1,
    });
    await panel.recover(async () => []);
  });

  it('blocks an incomplete inventory even without stored tab IDs', async () => {
    const state = profile();
    state.values.set(BROWSER_EXECUTION_SAFETY_KEY, { allTabs: true, tabIds: [], version: 1 });
    const panel = state.panel();
    await panel.refresh();
    expect(panel.getSnapshot().blockedReason).toContain('Close all target tabs');
    await expect(panel.acquireLocal()).resolves.toMatchObject({
      admitted: false,
      reason: expect.stringContaining('Close all target tabs'),
    });
    await expect(panel.recover(async () => [7])).resolves.toMatchObject({ recovered: false });
    await expect(panel.recover(async () => [])).resolves.toMatchObject({ recovered: true });
    const next = admitted(await panel.acquireLocal());
    await expect(next.run(async () => 'explicit submission')).resolves.toBe('explicit submission');
  });

  it('clears the displayed owner at idle and never exposes unsafe label text', async () => {
    const panel = profile().panel();
    const provider = admitted(await panel.acquireProviderOwner());
    const delegated = admitted(
      await panel.acquireDelegated(provider, '<parent>\n\u202E-a', new AbortController().signal)
    );
    await panel.refresh();
    expect(panel.getSnapshot().owner).toBe('CLI session parent-a');
    await delegated.release();
    await panel.refresh();
    expect(panel.getSnapshot()).toMatchObject({
      blockedReason: undefined,
      delegated: 'idle',
      localRuns: 0,
      owner: undefined,
    });
  });
});
