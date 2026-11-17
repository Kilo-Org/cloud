/* eslint-disable max-lines -- the lease table, its queue and its storage adapter share one contract (D10); splitting them would scatter the one-owner-per-tab invariant. */
import { z } from 'zod';
import { browserCallerKey, browserCallerSchema } from './browser-caller';
import type { BrowserCaller } from './browser-caller';

/**
 * How long a caller that may not take a tab over — an agent or a workflow run —
 * waits for a tab someone else holds before `tab_busy`. Panels never wait: they
 * ask the user for a take-over instead.
 */
export const AGENT_TAB_WAIT_MS = 30_000;

export const TAB_LEASES_STORAGE_KEY = 'session:kiloBrowserTabLeases';

export interface TabLeaseHolder {
  readonly caller: BrowserCaller;
  readonly key: string;
  readonly title?: string;
}

/**
 * - `granted`: the caller owns the tab now. `takeover` names the agent it took
 *   the tab from, whose in-flight call the runtime ends with `tab_taken`.
 * - `busy`: the wait ran out (`tab_busy`). Agents time out after
 *   `AGENT_TAB_WAIT_MS`; a dropped queue slot for a disposed caller also lands
 *   here.
 * - `needs_take_over`: a panel asked for a tab an agent holds. The panel must
 *   show its confirmation and ask again with `takeOver`.
 */
export type TabLeaseResult =
  | { readonly kind: 'granted'; readonly takeover?: TabLeaseHolder }
  | { readonly kind: 'busy' }
  | { readonly kind: 'needs_take_over'; readonly holder: TabLeaseHolder };

export interface TabLeaseAcquireOptions {
  readonly signal?: AbortSignal | undefined;
  /** A panel passes this only after its take-over confirmation. */
  readonly takeOver?: boolean;
  /** Display name for the holder, shown in another panel's take-over prompt. */
  readonly title?: string;
}

export interface TabLeasePersistence {
  /** `undefined` when storage held nothing usable: the tab is free. */
  readonly read: () => Promise<PersistedTabLease[] | undefined>;
  readonly write: (leases: readonly PersistedTabLease[]) => Promise<void>;
}

export interface TabLeaseRegistry {
  readonly acquire: (
    tabId: number,
    caller: BrowserCaller,
    options?: TabLeaseAcquireOptions
  ) => Promise<TabLeaseResult>;
  /** Waits until every pending persistence write has landed. */
  readonly flush: () => Promise<void>;
  readonly holder: (tabId: number) => TabLeaseHolder | undefined;
  readonly release: (tabId: number, caller: BrowserCaller) => void;
  /** Releases every tab the caller holds and drops its queued waits; returns how many leases it freed. */
  readonly releaseCaller: (caller: BrowserCaller) => number;
  /** Tab closed: the lease and its whole queue go away. */
  readonly releaseTab: (tabId: number) => void;
}

const persistedTabLeaseSchema = z.object({
  caller: browserCallerSchema,
  tabId: z.number(),
  title: z.string().optional(),
});
const persistedTabLeasesSchema = z.array(persistedTabLeaseSchema);

export type PersistedTabLease = z.infer<typeof persistedTabLeaseSchema>;

interface QueuedWaiter {
  readonly caller: BrowserCaller;
  readonly key: string;
  readonly title?: string;
  readonly resolve: (result: TabLeaseResult) => void;
  detachAbort?: (() => void) | undefined;
  timer?: ReturnType<typeof setTimeout>;
}

/** A settled waiter fires nothing again: its timeout is cancelled and its abort listener detached. */
const settleWaiter = (waiter: QueuedWaiter): void => {
  clearTimeout(waiter.timer);
  waiter.detachAbort?.();
  waiter.detachAbort = undefined;
};

/**
 * The tab lease table: one owner per tab, a FIFO queue of waiting callers, and
 * the one asymmetry the design fixes (D10) — a panel may take a tab from an
 * agent after a confirmation, and an agent never takes a tab from anyone.
 *
 * Only holders persist. Waiters belong to live message calls and cannot outlive
 * the service worker that received them.
 */
export const createTabLeaseRegistry = ({
  persistence,
}: {
  readonly persistence?: TabLeasePersistence | undefined;
}): TabLeaseRegistry => {
  const holders = new Map<number, TabLeaseHolder>();
  const queues = new Map<number, QueuedWaiter[]>();
  let loadPromise: Promise<void> | undefined = undefined;
  /*
   * Releases that land while the initial storage read is in flight. They see an
   * empty holders map, so the stored copy must not be re-inserted afterwards:
   * a closed tab or a disposed caller would come back as a phantom owner.
   */
  const releasedWhileLoading = { callers: new Set<string>(), tabs: new Set<number>() };
  let loading = false;
  // The newest snapshot not yet written; a burst of lease changes writes only the last one.
  let pendingSnapshot: PersistedTabLease[] | undefined = undefined;
  let writeChain: Promise<void> = Promise.resolve();
  let draining = false;

  const snapshotLeases = (): PersistedTabLease[] => {
    const snapshot: PersistedTabLease[] = [];

    for (const [tabId, holder] of holders) {
      snapshot.push({
        caller: holder.caller,
        tabId,
        ...(holder.title === undefined ? {} : { title: holder.title }),
      });
    }

    return snapshot;
  };

  const writePending = async (store: TabLeasePersistence): Promise<void> => {
    const snapshot = pendingSnapshot;
    pendingSnapshot = undefined;

    if (snapshot === undefined) {
      return;
    }

    try {
      await store.write(snapshot);
    } catch (error) {
      console.warn('Failed to persist browser tab leases:', error);
    }

    // Leases changed while the write was in flight: write the newest snapshot too.
    await writePending(store);
  };

  const startWrite = async (store: TabLeasePersistence): Promise<void> => {
    draining = true;

    try {
      await writePending(store);
    } finally {
      draining = false;
    }
  };

  const persist = (): void => {
    if (persistence === undefined) {
      return;
    }

    pendingSnapshot = snapshotLeases();

    if (!draining) {
      writeChain = startWrite(persistence);
    }
  };

  const readStored = async (
    store: TabLeasePersistence
  ): Promise<PersistedTabLease[] | undefined> => {
    try {
      return await store.read();
    } catch (error) {
      console.warn('Failed to read browser tab leases:', error);
      return undefined;
    }
  };

  const load = async (store: TabLeasePersistence): Promise<void> => {
    const stored = await readStored(store);

    if (stored === undefined) {
      return;
    }

    for (const lease of stored) {
      const releasedWhileReading =
        releasedWhileLoading.tabs.has(lease.tabId) ||
        releasedWhileLoading.callers.has(browserCallerKey(lease.caller));

      // A live waiter already claimed the tab in this service worker; the persisted copy is stale.
      // So is a lease a close or a dispose released while this read was in flight.
      if (!holders.has(lease.tabId) && !releasedWhileReading) {
        holders.set(lease.tabId, {
          caller: lease.caller,
          key: browserCallerKey(lease.caller),
          ...(lease.title === undefined ? {} : { title: lease.title }),
        });
      }
    }
  };

  /** `undefined` when leases are already in memory: the caller must not yield before it queues. */
  const ready = (): Promise<void> | undefined => {
    if (persistence === undefined) {
      return undefined;
    }

    loadPromise ??= (async () => {
      loading = true;

      try {
        await load(persistence);
      } finally {
        loading = false;
        releasedWhileLoading.callers.clear();
        releasedWhileLoading.tabs.clear();
      }
    })();

    return loadPromise;
  };

  /** Remembers a release that arrived before the persisted leases were read (see `releasedWhileLoading`). */
  const noteReleased = ({ key, tabId }: { key?: string; tabId?: number }): void => {
    if (!loading) {
      return;
    }

    if (key !== undefined) {
      releasedWhileLoading.callers.add(key);
    }

    if (tabId !== undefined) {
      releasedWhileLoading.tabs.add(tabId);
    }
  };

  const queueFor = (tabId: number): QueuedWaiter[] => {
    const existing = queues.get(tabId);

    if (existing !== undefined) {
      return existing;
    }

    const created: QueuedWaiter[] = [];
    queues.set(tabId, created);
    return created;
  };

  const grantNext = (tabId: number): void => {
    const queue = queues.get(tabId);

    if (queue === undefined) {
      return;
    }

    const waiter = queue.shift();

    if (waiter === undefined) {
      queues.delete(tabId);
      return;
    }

    settleWaiter(waiter);

    holders.set(tabId, {
      caller: waiter.caller,
      key: waiter.key,
      ...(waiter.title === undefined ? {} : { title: waiter.title }),
    });
    persist();
    waiter.resolve({ kind: 'granted' });
  };

  const grant = (tabId: number, caller: BrowserCaller, title?: string): void => {
    holders.set(tabId, {
      caller,
      key: browserCallerKey(caller),
      ...(title === undefined ? {} : { title }),
    });
    persist();
  };

  const removeQueued = (tabId: number, predicate: (waiter: QueuedWaiter) => boolean): void => {
    const queue = queues.get(tabId);

    if (queue === undefined) {
      return;
    }

    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const waiter = queue[index];

      if (waiter !== undefined && predicate(waiter)) {
        queue.splice(index, 1);
        settleWaiter(waiter);
        waiter.resolve({ kind: 'busy' });
      }
    }

    if (queue.length === 0) {
      queues.delete(tabId);
    }
  };

  /**
   * A caller that may not take a tab over waits a bounded window. The timed-out
   * waiter leaves the queue like every other settle path: a later release must
   * not hand the tab to a caller that already got `tab_busy`, which no one would
   * ever release.
   */
  const waitForCallerTimeout = (tabId: number, waiter: QueuedWaiter): void => {
    waiter.timer = setTimeout(() => {
      removeQueued(tabId, candidate => candidate === waiter);
    }, AGENT_TAB_WAIT_MS);
  };

  const release = (tabId: number, caller: BrowserCaller): void => {
    const holder = holders.get(tabId);
    const key = browserCallerKey(caller);

    noteReleased({ key, tabId });

    if (holder === undefined || holder.key !== key) {
      return;
    }

    holders.delete(tabId);
    persist();
    grantNext(tabId);
  };

  const acquire = async (
    tabId: number,
    caller: BrowserCaller,
    options?: TabLeaseAcquireOptions
  ): Promise<TabLeaseResult> => {
    const signal = options?.signal;
    // Read through a call: the signal can also fire while the persisted leases load.
    const callerGone = (): boolean => signal?.aborted === true;

    // An aborted caller owns nothing: it must not take a lease it will never release.
    if (callerGone()) {
      return { kind: 'busy' };
    }

    const pending = ready();

    if (pending !== undefined) {
      await pending;

      if (callerGone()) {
        return { kind: 'busy' };
      }
    }

    const key = browserCallerKey(caller);
    const holder = holders.get(tabId);

    if (holder === undefined) {
      grant(tabId, caller, options?.title);
      return { kind: 'granted' };
    }

    // The owner asking again keeps its lease; calls are serialized separately.
    if (holder.key === key) {
      return { kind: 'granted' };
    }

    if (caller.kind === 'panel' && holder.caller.kind === 'agent') {
      if (options?.takeOver !== true) {
        return { holder, kind: 'needs_take_over' };
      }

      grant(tabId, caller, options.title);
      return { kind: 'granted', takeover: holder };
    }

    const { promise, resolve } = Promise.withResolvers<TabLeaseResult>();
    const waiter: QueuedWaiter = {
      caller,
      key,
      resolve,
      ...(options?.title === undefined ? {} : { title: options.title }),
    };

    queueFor(tabId).push(waiter);

    // Only a panel may take a tab over, so only a panel may wait without a bound (for the user's confirmation answer).
    if (caller.kind !== 'panel') {
      waitForCallerTimeout(tabId, waiter);
    }

    if (signal !== undefined) {
      const onAbort = (): void => {
        removeQueued(tabId, candidate => candidate === waiter);
      };

      // Detached when the waiter settles: a long-lived turn controller must not accumulate listeners.
      waiter.detachAbort = () => {
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort);
    }

    return promise;
  };

  const releaseCaller = (caller: BrowserCaller): number => {
    const key = browserCallerKey(caller);
    let released = 0;

    noteReleased({ key });

    for (const [tabId, holder] of holders) {
      if (holder.key === key) {
        holders.delete(tabId);
        persist();
        released += 1;
        grantNext(tabId);
      }
    }

    for (const tabId of queues.keys()) {
      removeQueued(tabId, waiter => waiter.key === key);
    }

    return released;
  };

  const releaseTab = (tabId: number): void => {
    const holder = holders.get(tabId);

    noteReleased({ tabId });

    if (holder !== undefined) {
      holders.delete(tabId);
      persist();
    }

    removeQueued(tabId, () => true);
  };

  return {
    acquire,
    flush: () => writeChain,
    holder: tabId => holders.get(tabId),
    release,
    releaseCaller,
    releaseTab,
  };
};

/**
 * Leases survive a service-worker restart in `storage.session`: a restart must
 * not hand an agent's tab to the side panel without the confirmation, and must
 * not let two owners believe they hold the same tab.
 */
export const createStorageSessionLeasePersistence = (storageArea: {
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- storage hands back whatever an earlier write left; `read` parses it with the lease schema.
  readonly getItem: (key: typeof TAB_LEASES_STORAGE_KEY) => unknown;
  readonly setItem: (
    key: typeof TAB_LEASES_STORAGE_KEY,
    value: PersistedTabLease[]
  ) => Promise<void> | void;
}): TabLeasePersistence => ({
  read: async () => {
    const parsed = persistedTabLeasesSchema.safeParse(
      await storageArea.getItem(TAB_LEASES_STORAGE_KEY)
    );

    return parsed.success ? parsed.data : undefined;
  },
  write: async leases => {
    await storageArea.setItem(TAB_LEASES_STORAGE_KEY, [...leases]);
  },
});
