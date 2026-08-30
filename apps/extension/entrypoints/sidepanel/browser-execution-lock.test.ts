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
    panel: (panelLocks = locks) =>
      createBrowserExecutionCoordinator({
        locks: supportsLocks ? panelLocks : undefined,
        storageArea,
      }),
    storageArea,
    values,
  };
};

// Model context destruction by releasing its native requests, not by settling the issued page work.
// Actual Chrome/Firefox panel destruction remains a13 verification.
const nativeContext = () => {
  const destroyed = Promise.withResolvers<void>();
  const requests: Promise<unknown>[] = [];
  const callbacks: unknown[] = [];
  type Work = (lock: Lock | null) => unknown;
  const request = (name: string, options: LockOptions | Work, callback?: Work) => {
    const work = typeof options === 'function' ? options : callback;
    if (work === undefined) {
      throw new Error('Missing native lock callback');
    }
    const running = locks.request(name, typeof options === 'function' ? {} : options, lock => {
      const pending = work(lock);
      callbacks.push(pending);
      return Promise.race([pending, destroyed.promise]);
    });
    requests.push(running);
    return running;
  };
  return {
    destroy: async () => {
      destroyed.resolve();
      await Promise.all(requests);
    },
    drain: async () => {
      // Late callbacks can append a final safety mutation while earlier callbacks drain.
      for (const callback of callbacks) {
        // eslint-disable-next-line no-await-in-loop -- Include callbacks appended by each awaited completion.
        await callback;
      }
    },
    locks: { query: () => locks.query(), request } as LockManager,
  };
};

describe('profile browser execution locks', () => {
  afterEach(async () => {
    await Promise.all([...leases].map(lease => lease.release()));
    leases.clear();
  });

  it('records bound tabs before dispatch and removes only each completed shared run', async () => {
    const state = profile();
    const first = state.panel();
    const second = state.panel();
    const one = admitted(await first.acquireLocal());
    const startedOne = Promise.withResolvers<void>();
    const startedTwo = Promise.withResolvers<void>();
    const finishOne = Promise.withResolvers<void>();
    const finishTwo = Promise.withResolvers<void>();
    const issued: unknown[] = [];
    const workOne = one.run(async () => {
      issued.push(structuredClone(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)));
      startedOne.resolve();
      await finishOne.promise;
      return 'first tab completed';
    }, 0);
    await startedOne.promise;
    const two = admitted(await second.acquireLocal());
    const workTwo = two.run(async () => {
      issued.push(structuredClone(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)));
      startedTwo.resolve();
      await finishTwo.promise;
      return 'second tab completed';
    }, 8);
    try {
      await startedTwo.promise;
      expect(issued).toMatchObject([
        { localRuns: [{ tabId: 0 }], tabIds: [] },
        { localRuns: [{ tabId: 0 }, { tabId: 8 }], tabIds: [] },
      ]);
      finishOne.resolve();
      await expect(workOne).resolves.toBe('first tab completed');
      await one.release();
      expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({
        localRuns: [{ tabId: 8 }],
        tabIds: [],
      });
      const joining = admitted(await state.panel().acquireLocal());
      await joining.release();
      await second.refresh();
      expect(second.getSnapshot()).toMatchObject({ blockedReason: undefined, localRuns: 1 });
    } finally {
      finishOne.resolve();
      finishTwo.resolve();
      await Promise.all([workOne, workTwo]);
      await Promise.all([one.release(), two.release()]);
    }
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      tabIds: [],
      version: 1,
    });
    const reloaded = state.panel();
    const provider = admitted(await reloaded.acquireProviderOwner());
    const delegated = admitted(
      await reloaded.acquireDelegated(provider, 'after-completion', new AbortController().signal)
    );
    await expect(delegated.run(async () => 'next work')).resolves.toBe('next work');
  });

  it('keeps guarded shared work running when a populated refresh crosses normal completion', async () => {
    const state = profile();
    const first = state.panel();
    const second = state.panel();
    const one = admitted(await first.acquireLocal());
    const two = admitted(await second.acquireLocal());
    const startedOne = Promise.withResolvers<void>();
    const startedTwo = Promise.withResolvers<void>();
    const finishOne = Promise.withResolvers<void>();
    const finishTwo = Promise.withResolvers<void>();
    const workOne = one.run(async () => {
      startedOne.resolve();
      await finishOne.promise;
      return 'first tab completed';
    }, 7);
    const workTwo = two.run(async guard => {
      startedTwo.resolve();
      await finishTwo.promise;
      guard();
      return 'second tab completed';
    }, 8);
    await Promise.all([startedOne.promise, startedTwo.promise]);
    const read = state.storageArea.getItem;
    const captured = Promise.withResolvers<void>();
    const stale = Promise.withResolvers<void>();
    let delayed = false;
    state.storageArea.getItem = async key => {
      const value = read(key);
      if (key === BROWSER_EXECUTION_SAFETY_KEY && !delayed) {
        delayed = true;
        captured.resolve();
        await stale.promise;
      }
      return value;
    };
    const refreshing = second.refresh();
    try {
      await captured.promise;
      finishOne.resolve();
      await expect(workOne).resolves.toBe('first tab completed');
      await one.release();
      expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({
        localRuns: [{ tabId: 8 }],
        tabIds: [],
      });
      stale.resolve();
      await refreshing;
      finishTwo.resolve();
      await expect(workTwo).resolves.toBe('second tab completed');
      expect(second.getSnapshot()).toMatchObject({
        blockedReason: undefined,
        quarantinedTabIds: [],
      });
    } finally {
      stale.resolve();
      finishOne.resolve();
      finishTwo.resolve();
      state.storageArea.getItem = read;
      await Promise.allSettled([refreshing, workOne, workTwo]);
      await Promise.all([one.release(), two.release()]);
    }
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      tabIds: [],
      version: 1,
    });
  });

  it('serializes simultaneous completions from separate coordinators', async () => {
    const state = profile();
    const one = admitted(await state.panel().acquireLocal());
    const two = admitted(await state.panel().acquireLocal());
    const finish = Promise.withResolvers<void>();
    let issued = 0;
    const execute = async () => {
      issued += 1;
      await finish.promise;
    };
    const workOne = one.run(execute, 7);
    const workTwo = two.run(execute, 8);
    try {
      await vi.waitFor(() => {
        expect(issued).toBe(2);
      });
    } finally {
      finish.resolve();
      await Promise.all([workOne, workTwo]);
      await Promise.all([one.release(), two.release()]);
    }
    const next = admitted(await state.panel().acquireLocal());
    await expect(next.run(async () => 'both runs drained', 0)).resolves.toBe('both runs drained');
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      tabIds: [],
      version: 1,
    });
  });

  it.each([0, 7])('retains tab %s protection after native owner loss and reload', async tabId => {
    const state = profile();
    const context = nativeContext();
    const owner = state.panel(context.locks);
    const observer = state.panel();
    const local = admitted(await owner.acquireLocal());
    const issued = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const effects: string[] = [];
    const running = local.run(async () => {
      issued.resolve();
      await finish.promise;
      effects.push('page work settled');
    }, tabId);
    try {
      await issued.promise;
      await observer.refresh();
      expect(observer.getSnapshot().blockedReason).toBeUndefined();
      await context.destroy();
      await local.release();
      const reloaded = state.panel();
      const provider = admitted(await reloaded.acquireProviderOwner());
      expect({
        delegated: (
          await reloaded.acquireDelegated(provider, 'after-loss', new AbortController().signal)
        ).admitted,
        effects,
        existingPanel: await observer.acquireLocal(),
        reloadedPanel: await reloaded.acquireLocal(),
      }).toMatchObject({
        delegated: false,
        effects: [],
        existingPanel: {
          admitted: false,
          reason: expect.stringContaining('Close the affected tabs'),
        },
        reloadedPanel: {
          admitted: false,
          reason: expect.stringContaining('Close the affected tabs'),
        },
      });
      expect(reloaded.getSnapshot().quarantinedTabIds).toStrictEqual([tabId]);
    } finally {
      finish.resolve();
      await running;
      await local.release();
      await context.drain();
    }
    // A late result cannot prove completion on behalf of a destroyed native owner.
    expect({
      admission: await observer.acquireLocal(),
      effects,
      openReadiness: await observer.prepareRecovery(async () => [tabId]),
      readiness: await observer.prepareRecovery(async () => []),
      rechecked: await observer.recover(async () => [tabId]),
      recovery: await observer.recover(async () => []),
    }).toMatchObject({
      admission: { admitted: false },
      effects: ['page work settled'],
      openReadiness: { ready: false },
      readiness: { ready: true },
      rechecked: { recovered: false },
      recovery: { recovered: true },
    });
    const next = admitted(await observer.acquireLocal());
    await expect(next.run(async () => 'explicit new work', 8)).resolves.toBe('explicit new work');
  });

  it('rechecks durable protection before dispatch despite another panel returning a stale empty read', async () => {
    const state = profile();
    const context = nativeContext();
    const owner = state.panel(context.locks);
    const observer = state.panel();
    const existing = admitted(await observer.acquireLocal());
    const local = admitted(await owner.acquireLocal());
    const read = state.storageArea.getItem;
    const captured = Promise.withResolvers<void>();
    const stale = Promise.withResolvers<void>();
    let delayed = false;
    state.storageArea.getItem = async key => {
      const value = read(key);
      if (key === BROWSER_EXECUTION_SAFETY_KEY && !delayed) {
        delayed = true;
        captured.resolve();
        await stale.promise;
      }
      return value;
    };
    const refreshing = observer.refresh();
    await captured.promise;
    const issued = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = local.run(async () => {
      issued.resolve();
      await finish.promise;
    }, 7);
    const effects: string[] = [];
    try {
      await issued.promise;
      await context.destroy();
      await local.release();
      stale.resolve();
      await refreshing;
      await expect(
        existing.run(async () => {
          effects.push('unsafe dispatch');
        }, 8)
      ).rejects.toThrow('profile_quarantined');
      expect(effects).toStrictEqual([]);
      await expect(observer.acquireLocal()).resolves.toMatchObject({ admitted: false });
      await expect(state.panel().acquireLocal()).resolves.toMatchObject({ admitted: false });
    } finally {
      stale.resolve();
      state.storageArea.getItem = read;
      finish.resolve();
      await Promise.all([refreshing, running]);
      await local.release();
      await context.drain();
    }
  });

  it('does not let a stale completion erase a new run or quarantine after recovery', async () => {
    const state = profile();
    const context = nativeContext();
    const lost = admitted(await state.panel(context.locks).acquireLocal());
    const issued = Promise.withResolvers<void>();
    const finishLost = Promise.withResolvers<void>();
    const oldWork = lost.run(async () => {
      issued.resolve();
      await finishLost.promise;
    }, 7);
    await issued.promise;
    await context.destroy();
    await lost.release();
    const nextPanel = state.panel();
    await expect(nextPanel.recover(async () => [])).resolves.toMatchObject({ recovered: true });
    const next = admitted(await nextPanel.acquireLocal());
    const nextIssued = Promise.withResolvers<void>();
    const finishNext = Promise.withResolvers<void>();
    const nextWork = next.run(async () => {
      nextIssued.resolve();
      await finishNext.promise;
    }, 8);
    try {
      await nextIssued.promise;
      const uncertain = admitted(await state.panel().acquireLocal());
      await uncertain.quarantine(9);
      await uncertain.release();
      const protectedState = structuredClone(state.values.get(BROWSER_EXECUTION_SAFETY_KEY));
      finishLost.resolve();
      await oldWork;
      await context.drain();
      expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual(protectedState);
      expect(protectedState).toMatchObject({ localRuns: [{ tabId: 8 }], tabIds: [9] });
    } finally {
      finishLost.resolve();
      finishNext.resolve();
      await Promise.all([oldWork, nextWork]);
      await Promise.all([lost.release(), next.release()]);
      await context.drain();
    }
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      tabIds: [9],
      version: 1,
    });
    await expect(state.panel().acquireLocal()).resolves.toMatchObject({ admitted: false });
  });

  it.each([false, true])(
    'rejects dispatch when the protection write fails (persisted=%s)',
    async persisted => {
      const state = profile();
      const panel = state.panel();
      const local = admitted(await panel.acquireLocal());
      const write = state.storageArea.setItem;
      const effects: string[] = [];
      state.storageArea.setItem = async (key, value) => {
        if (persisted) {
          await write(key, value);
        }
        throw new Error('storage unavailable');
      };
      try {
        await expect(
          local.run(async () => {
            effects.push('unsafe dispatch');
          }, 7)
        ).rejects.toThrow('storage unavailable');
        await local.release();
        expect({
          admission: await panel.acquireLocal(),
          effects,
          persisted: state.values.has(BROWSER_EXECUTION_SAFETY_KEY),
        }).toMatchObject({
          admission: { admitted: false, reason: expect.stringContaining('Restore storage access') },
          effects: [],
          persisted,
        });
      } finally {
        state.storageArea.setItem = write;
      }
      await expect(panel.recover(async () => [])).resolves.toMatchObject({ recovered: true });
      const next = admitted(await state.panel().acquireLocal());
      await expect(next.run(async () => 'explicit retry', 8)).resolves.toBe('explicit retry');
    }
  );

  it('retains durable protection when completion cannot be persisted', async () => {
    const state = profile();
    const panel = state.panel();
    const local = admitted(await panel.acquireLocal());
    const issued = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = local.run(async () => {
      issued.resolve();
      await finish.promise;
    }, 7);
    await issued.promise;
    const write = state.storageArea.setItem;
    state.storageArea.setItem = () => {
      throw new Error('storage unavailable');
    };
    try {
      finish.resolve();
      await expect(running).rejects.toThrow('storage unavailable');
      await local.release();
    } finally {
      state.storageArea.setItem = write;
    }
    const reloaded = state.panel();
    await expect(reloaded.acquireLocal()).resolves.toMatchObject({ admitted: false });
    await expect(reloaded.recover(async () => [7])).resolves.toMatchObject({ recovered: false });
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({
      localRuns: [{ tabId: 7 }],
    });
    await expect(reloaded.recover(async () => [])).resolves.toMatchObject({ recovered: true });
    admitted(await reloaded.acquireLocal());
  });

  it('retains protection for an unexpected result loss without misreporting a storage error', async () => {
    const state = profile();
    const local = admitted(await state.panel().acquireLocal());
    await expect(
      local.run(async () => {
        throw new Error('page result lost');
      }, 7)
    ).rejects.toThrow('page result lost');
    await local.release();
    const reloaded = state.panel();
    await expect(reloaded.acquireLocal()).resolves.toMatchObject({
      admitted: false,
      reason: expect.stringContaining('Close the affected tabs'),
    });
    await expect(reloaded.recover(async () => [7])).resolves.toMatchObject({ recovered: false });
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
      await expect(panel.prepareRecovery(async () => [])).resolves.toMatchObject({
        ready: false,
        reason: expect.stringContaining('unwinding'),
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

  it('prepares a discarded failed lease without clearing quarantine or admitting work', async () => {
    const state = profile();
    const panel = state.panel();
    const otherPanel = state.panel();
    const provider = admitted(await otherPanel.acquireProviderOwner());
    const write = state.storageArea.setItem;
    {
      const local = admitted(await panel.acquireLocal());
      state.storageArea.setItem = () => {
        throw new Error('storage unavailable');
      };
      await expect(local.quarantine(7)).rejects.toThrow('storage unavailable');
      await expect(local.release()).rejects.toThrow('storage unavailable');
      leases.delete(local);
    }
    try {
      const unavailable = await panel.prepareRecovery(async () => []);
      state.storageArea.setItem = write;
      // A display-only refresh leaves the failed-release lock held after storage returns.
      await panel.refresh();
      expect({
        admitted: (await otherPanel.acquireLocal()).admitted,
        localRuns: panel.getSnapshot().localRuns,
        persisted: state.values.has(BROWSER_EXECUTION_SAFETY_KEY),
        unavailable,
      }).toStrictEqual({
        admitted: false,
        localRuns: 1,
        persisted: false,
        unavailable: { ready: false, reason: expect.stringContaining('Restore storage access') },
      });

      const readiness = await panel.prepareRecovery(async () => []);
      expect({
        delegated: (
          await otherPanel.acquireDelegated(provider, 'parent-b', new AbortController().signal)
        ).admitted,
        local: (await otherPanel.acquireLocal()).admitted,
        localRuns: panel.getSnapshot().localRuns,
        readiness,
        safety: state.values.get(BROWSER_EXECUTION_SAFETY_KEY),
      }).toStrictEqual({
        delegated: false,
        local: false,
        localRuns: 0,
        readiness: { ready: true, reason: expect.stringContaining('Recover explicitly') },
        safety: { tabIds: [7], version: 1 },
      });
    } finally {
      state.storageArea.setItem = write;
      await panel.recover(async () => []);
    }
  });

  it('does not prepare a failed lease until its caller requests release', async () => {
    const state = profile();
    const panel = state.panel();
    const local = admitted(await panel.acquireLocal());
    const write = state.storageArea.setItem;
    state.storageArea.setItem = () => {
      throw new Error('storage unavailable');
    };
    await expect(local.quarantine(7)).rejects.toThrow('storage unavailable');
    state.storageArea.setItem = write;
    try {
      await expect(panel.prepareRecovery(async () => [])).resolves.toMatchObject({
        ready: false,
        reason: expect.stringContaining('unwinding'),
      });
      expect(state.values.has(BROWSER_EXECUTION_SAFETY_KEY)).toBe(false);
      expect(panel.getSnapshot().localRuns).toBe(1);
    } finally {
      await local.quarantine(7);
      await local.release();
    }
  });

  it('rejects queued delegation when preparation drains a failed release', async () => {
    const state = profile();
    const panel = state.panel();
    const otherPanel = state.panel();
    const local = admitted(await panel.acquireLocal());
    const provider = admitted(await otherPanel.acquireProviderOwner());
    const waiting = otherPanel.acquireDelegated(provider, 'parent-b', new AbortController().signal);
    await vi.waitFor(async () => {
      expect((await locks.query()).pending).toHaveLength(1);
    });
    const write = state.storageArea.setItem;
    state.storageArea.setItem = () => {
      throw new Error('storage unavailable');
    };
    await expect(local.quarantine(7)).rejects.toThrow('storage unavailable');
    await expect(local.release()).rejects.toThrow('storage unavailable');
    state.storageArea.setItem = write;
    try {
      // The rejected waiter can still be unwinding during the first native readiness check.
      await panel.prepareRecovery(async () => []);
      const admission = await waiting;
      if (admission.admitted) {
        admitted(admission);
      }
      expect(admission).toMatchObject({
        admitted: false,
        reason: expect.stringContaining('Close the affected tabs'),
      });
      await expect(panel.prepareRecovery(async () => [])).resolves.toMatchObject({ ready: true });
      expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
        tabIds: [7],
        version: 1,
      });
    } finally {
      await panel.recover(async () => []);
    }
  });

  it.each(['shared', 'exclusive'] as const)(
    'rechecks native %s locks after earlier readiness without waiting or stealing',
    async mode => {
      const state = profile();
      const record = { tabIds: [7], version: 1 };
      state.values.set(BROWSER_EXECUTION_SAFETY_KEY, record);
      const panel = state.panel();
      await expect(panel.prepareRecovery(async () => [])).resolves.toMatchObject({ ready: true });
      const entered = Promise.withResolvers<void>();
      const drain = Promise.withResolvers<void>();
      const holding = locks.request(BROWSER_EXECUTION_LOCK, { mode }, () => {
        entered.resolve();
        return drain.promise;
      });
      await entered.promise;
      try {
        await expect(state.panel().prepareRecovery(async () => [])).resolves.toMatchObject({
          ready: false,
          reason: expect.stringContaining('unwinding'),
        });
        await expect(panel.recover(async () => [])).resolves.toMatchObject({
          reason: expect.stringContaining('unwinding'),
          recovered: false,
        });
        expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual(record);
        expect(
          (await locks.query()).held?.filter(lock => lock.name === BROWSER_EXECUTION_LOCK)
        ).toMatchObject([{ mode }]);
      } finally {
        drain.resolve();
        await holding;
      }
    }
  );

  it.each(['unavailable', 'corrupt'] as const)(
    'fails preparation closed on %s storage and rechecks it during recovery',
    async failure => {
      const state = profile();
      const record = { tabIds: [7], version: 1 };
      state.values.set(BROWSER_EXECUTION_SAFETY_KEY, record);
      const panel = state.panel();
      await expect(panel.prepareRecovery(async () => [])).resolves.toMatchObject({ ready: true });
      const read = state.storageArea.getItem;
      state.storageArea.getItem = key => {
        if (key === BROWSER_EXECUTION_SAFETY_KEY) {
          if (failure === 'unavailable') {
            throw new Error('storage unavailable');
          }
          return { tabIds: ['7'], version: 1 };
        }
        return read(key);
      };
      try {
        await expect(panel.prepareRecovery(async () => [])).resolves.toMatchObject({
          ready: false,
          reason: expect.stringContaining('Restore storage'),
        });
        await expect(panel.recover(async () => [])).rejects.toThrow(
          failure === 'unavailable' ? 'storage unavailable' : 'expected number'
        );
        expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual(record);
        expect((await panel.acquireLocal()).admitted).toBe(false);
      } finally {
        state.storageArea.getItem = read;
      }
      await expect(panel.prepareRecovery(async () => [])).resolves.toMatchObject({ ready: true });
      expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual(record);
    }
  );

  it('rechecks newly persisted affected tabs and all-tabs closure after empty-profile readiness', async () => {
    const state = profile();
    const panel = state.panel();
    await expect(panel.prepareRecovery(async () => [])).resolves.toMatchObject({ ready: true });
    expect(state.values.size).toBe(0);
    state.values.set(BROWSER_EXECUTION_SAFETY_KEY, { tabIds: [7], version: 1 });
    await expect(panel.recover(async () => [7])).resolves.toStrictEqual({
      reason: 'Close all affected tabs before recovery.',
      recovered: false,
    });
    state.values.set(BROWSER_EXECUTION_SAFETY_KEY, { allTabs: true, tabIds: [], version: 1 });
    await expect(panel.recover(async () => [42])).resolves.toMatchObject({
      reason: expect.stringContaining('Close all target tabs'),
      recovered: false,
    });
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      allTabs: true,
      tabIds: [],
      version: 1,
    });
  });

  it.each(['recover', 'prepareRecovery'] as const)(
    'retains a failed fence during a pending retry write (%s)',
    async operation => {
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
      const checking = panel[operation](async () => [7, 8]);
      try {
        await vi.waitFor(() => {
          expect(writing).toBe(true);
        });
        expect(state.values.has(BROWSER_EXECUTION_SAFETY_KEY)).toBe(false);
        expect(
          (await locks.query()).held?.filter(lock => lock.name === BROWSER_EXECUTION_LOCK)
        ).toMatchObject([{ mode: 'shared' }]);
        expect((await state.panel().acquireLocal()).admitted).toBe(false);
        await expect(panel.prepareRecovery(async () => [])).resolves.toMatchObject({
          ready: false,
          reason: expect.stringContaining('unwinding'),
        });
        await expect(panel.recover(async () => [])).resolves.toMatchObject({ recovered: false });
      } finally {
        persist.resolve();
        state.storageArea.setItem = write;
      }
      await expect(checking).resolves.toStrictEqual({
        ...(operation === 'recover' ? { recovered: false } : { ready: false }),
        reason: 'Close all affected tabs before recovery.',
      });
      const readiness = await panel.prepareRecovery(async () => [8]);
      expect({
        admitted: (await state.panel().acquireLocal()).admitted,
        readiness,
        safety: state.values.get(BROWSER_EXECUTION_SAFETY_KEY),
      }).toMatchObject({ admitted: false, readiness: { ready: true }, safety: { tabIds: [7] } });
      await expect(panel.recover(async () => [8])).resolves.toStrictEqual({
        reason: 'Browser control recovered. Submit new work explicitly.',
        recovered: true,
      });
      expect(
        (await locks.query()).held?.filter(lock => lock.name === BROWSER_EXECUTION_LOCK)
      ).toHaveLength(0);
      const next = admitted(await panel.acquireLocal());
      await expect(next.run(async () => 'explicit new work')).resolves.toBe('explicit new work');
    }
  );

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
      await expect(panel.prepareRecovery(async () => [])).resolves.toMatchObject({
        ready: false,
        reason: expect.stringContaining('unwinding'),
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
    await expect(panel.prepareRecovery(async () => [])).resolves.toMatchObject({ ready: true });
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      tabIds: [7],
      version: 1,
    });
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

  it.each([
    {
      failure: 'negative tab',
      localRuns: [{ lockName: `${BROWSER_EXECUTION_LOCK}:local:lost`, tabId: -1 }],
    },
    { failure: 'foreign lock', localRuns: [{ lockName: BROWSER_EXECUTION_LOCK, tabId: 7 }] },
    { failure: 'invalid list', localRuns: 'invalid' },
  ])('fails closed on $failure protection data', async ({ localRuns }) => {
    const state = profile();
    const record = { localRuns, tabIds: [], version: 1 };
    state.values.set(BROWSER_EXECUTION_SAFETY_KEY, record);
    await expect(state.panel().acquireLocal()).resolves.toMatchObject({
      admitted: false,
      reason: expect.stringContaining('safety state is unavailable'),
    });
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual(record);
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
    await expect(local.run(async () => 'local result', 0)).resolves.toBe('local result');
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
    await expect(panel.prepareRecovery(async () => [])).resolves.toMatchObject({
      ready: false,
      reason: expect.stringContaining('Restore browser Web Locks support'),
    });
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
    expect({
      admission: await panel.acquireLocal(),
      blockedReason: panel.getSnapshot().blockedReason,
      preparation: await panel.prepareRecovery(async () => [7]),
      recovery: await panel.recover(async () => [7]),
    }).toMatchObject({
      admission: { admitted: false, reason: expect.stringContaining('Close all target tabs') },
      blockedReason: expect.stringContaining('Close all target tabs'),
      preparation: { ready: false, reason: expect.stringContaining('Close all target tabs') },
      recovery: { recovered: false },
    });
    await expect(
      panel.prepareRecovery(async () => {
        throw new Error('tab enumeration failed');
      })
    ).resolves.toMatchObject({
      ready: false,
      reason: expect.stringContaining('Restore storage and browser access'),
    });
    const readiness = await panel.prepareRecovery(async () => []);
    expect({
      admitted: (await panel.acquireLocal()).admitted,
      readiness,
      safety: state.values.get(BROWSER_EXECUTION_SAFETY_KEY),
    }).toStrictEqual({
      admitted: false,
      readiness: { ready: true, reason: expect.stringContaining('Recover explicitly') },
      safety: { allTabs: true, tabIds: [], version: 1 },
    });
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
