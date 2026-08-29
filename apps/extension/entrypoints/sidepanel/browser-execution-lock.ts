/* eslint-disable max-lines, promise/avoid-new -- Native lock callbacks hold a lease until its awaited work drains. */
import { storage } from '#imports';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { ExecutionStoppedError } from '@/src/shared/agent-tool-results';
import type { ExecutionGuard } from '@/src/shared/agent-tool-results';

export const PROVIDER_OWNER_LOCK = 'kilo:browser-provider-owner';
export const BROWSER_EXECUTION_LOCK = 'kilo:browser-execution';
// Account-independent safety data. Auth cleanup must preserve this key (slice a10).
export const BROWSER_EXECUTION_SAFETY_KEY = 'local:kiloBrowserExecutionSafety';
const OWNER_KEY = 'local:kiloBrowserExecutionOwner';
const SAFETY_WRITE_LOCK = 'kilo:browser-execution-safety-write';
const LOCKS_UNAVAILABLE =
  'CLI delegation is unavailable because this browser does not support Web Locks. Local browser work remains available.';
export const QUARANTINE_MESSAGE =
  'Browser control is blocked because an action may still be running. Close the affected tabs, then explicitly recover browser control. Issued actions cannot be undone.';
const ALL_TABS_RECOVERY_MESSAGE =
  'Close all target tabs before recovery. The affected-tab list is not known to be complete.';

const safetySchema = z.object({
  // Without Web Locks, competing writers can lose tab IDs.
  allTabs: z.literal(true).optional(),
  tabIds: z.array(z.number().int().nonnegative()),
  version: z.literal(1),
});
const ownerSchema = z.object({ sessionId: z.string().max(80) });
type SafetyRecord = z.infer<typeof safetySchema>;
type StorageKey = typeof BROWSER_EXECUTION_SAFETY_KEY | typeof OWNER_KEY;
export interface BrowserLockStorage {
  // eslint-disable-next-line anti-slop/no-unknown-returns -- Raw storage is untrusted; readSafety and ownerSchema validate it at this boundary.
  getItem: (key: StorageKey) => unknown;
  setItem: (key: StorageKey, value: unknown) => void | Promise<void>;
  watch: (key: StorageKey, callback: () => void) => () => void;
}
export interface BrowserExecutionSnapshot {
  readonly localRuns: number;
  readonly providerOwned: boolean;
  readonly delegated: 'idle' | 'waiting' | 'running';
  readonly owner: string | undefined;
  readonly blockedReason: string | undefined;
  readonly delegationUnavailableReason: string | undefined;
  readonly quarantinedTabIds: readonly number[];
}
export interface BrowserExecutionLease {
  readonly kind: 'local' | 'delegated' | 'provider';
  readonly guard: ExecutionGuard;
  readonly run: <Result>(work: (guard: ExecutionGuard) => Promise<Result>) => Promise<Result>;
  readonly quarantine: (tabId: number) => Promise<void>;
  readonly release: () => Promise<void>;
}
export type BrowserAdmission =
  | { readonly admitted: true; readonly lease: BrowserExecutionLease }
  | { readonly admitted: false; readonly reason: string };
export interface BrowserRecovery {
  readonly recovered: boolean;
  readonly reason: string;
}
export interface BrowserRecoveryReadiness {
  readonly ready: boolean;
  readonly reason: string;
}

/** Native locks grant authority; the observable record supplies display information only. */
export const createBrowserExecutionCoordinator = ({
  locks,
  storageArea,
}: {
  locks: LockManager | undefined;
  storageArea: BrowserLockStorage;
}) => {
  const listeners = new Set<() => void>();
  const providerLeases = new WeakSet<BrowserExecutionLease>();
  const pendingSafetyTabs = new Set<number>();
  const failedReleases = new Set<() => Promise<void>>();
  let safety: SafetyRecord = { tabIds: [], version: 1 };
  let safetyRevision = 0;
  let safetyError = false;
  let fallbackLocalRuns = 0;
  let delegationPending = false;
  let snapshot: BrowserExecutionSnapshot = {
    blockedReason: undefined,
    delegated: 'idle',
    delegationUnavailableReason: locks === undefined ? LOCKS_UNAVAILABLE : undefined,
    localRuns: 0,
    owner: undefined,
    providerOwned: false,
    quarantinedTabIds: [],
  };
  // eslint-disable-next-line init-declarations -- The first refresh supplies this deferred promise.
  let refreshInFlight: Promise<void> | undefined;
  const readSafety = async (): Promise<SafetyRecord> => {
    const value = await storageArea.getItem(BROWSER_EXECUTION_SAFETY_KEY);
    // Old profiles have no execution safety record. Remove this empty-record fallback after those profiles migrate.
    return value === null || value === undefined
      ? { tabIds: [], version: 1 }
      : safetySchema.parse(value);
  };
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  const safetyReason = (): string | undefined => {
    if (safetyError) {
      const recovery = safety.allTabs === true ? ` ${ALL_TABS_RECOVERY_MESSAGE}` : '';
      return `Browser safety state is unavailable. No browser work can start. Restore storage access before recovery.${recovery}`;
    }
    if (safety.allTabs === true) {
      return `Browser control is blocked because an action may still be running. ${ALL_TABS_RECOVERY_MESSAGE} Issued actions cannot be undone.`;
    }
    return safety.tabIds.length > 0 ? QUARANTINE_MESSAGE : undefined;
  };
  const refresh = (): Promise<void> => {
    refreshInFlight ??= (async () => {
      const revision = safetyRevision;
      try {
        const [record, nativeState, ownerValue] = await Promise.all([
          readSafety(),
          locks?.query(),
          storageArea.getItem(OWNER_KEY),
        ]);
        // A stale read cannot erase a fence while this panel writes it.
        if (revision === safetyRevision) {
          safety = {
            ...record,
            ...(safety.allTabs === true && pendingSafetyTabs.size > 0 ? { allTabs: true } : {}),
            tabIds: [...new Set([...record.tabIds, ...pendingSafetyTabs])],
          };
        }
        const held = nativeState?.held ?? [];
        const pending = nativeState?.pending ?? [];
        const running = held.some(
          lock => lock.name === BROWSER_EXECUTION_LOCK && lock.mode === 'exclusive'
        );
        const waiting = pending.some(
          lock => lock.name === BROWSER_EXECUTION_LOCK && lock.mode === 'exclusive'
        );
        const queued = waiting || delegationPending ? 'waiting' : 'idle';
        const delegated = running ? 'running' : queued;
        const parsedOwner = ownerSchema.safeParse(ownerValue);
        const ownerLabel = parsedOwner.success
          ? `CLI session ${parsedOwner.data.sessionId.replaceAll(/[^a-zA-Z0-9_-]/gu, '').slice(0, 12) || 'unknown'}`
          : 'A CLI session';
        const owner = delegated === 'idle' ? undefined : ownerLabel;
        const next: BrowserExecutionSnapshot = {
          blockedReason:
            safetyReason() ??
            (delegated === 'idle'
              ? undefined
              : `${owner} ${running ? 'owns' : 'is waiting for'} browser control. Use Stop or wait for it to finish, then submit again.`),
          delegated,
          delegationUnavailableReason: locks === undefined ? LOCKS_UNAVAILABLE : undefined,
          localRuns:
            locks === undefined
              ? fallbackLocalRuns
              : held.filter(lock => lock.name === BROWSER_EXECUTION_LOCK && lock.mode === 'shared')
                  .length,
          owner,
          providerOwned: held.some(lock => lock.name === PROVIDER_OWNER_LOCK),
          quarantinedTabIds: safety.tabIds,
        };
        if (JSON.stringify(next) !== JSON.stringify(snapshot)) {
          snapshot = next;
          notify();
        }
      } catch {
        safetyError = true;
        snapshot = { ...snapshot, blockedReason: safetyReason() };
        notify();
      } finally {
        refreshInFlight = undefined;
      }
    })();
    return refreshInFlight;
  };
  const quarantineBarriers = new Set<() => void>();
  const persistQuarantine = async (tabId: number): Promise<void> => {
    pendingSafetyTabs.add(tabId);
    safetyRevision += 1;
    safety = {
      ...safety,
      ...(locks === undefined ? { allTabs: true } : {}),
      tabIds: [...new Set([...safety.tabIds, tabId])],
    };
    snapshot = { ...snapshot, blockedReason: safetyReason(), quarantinedTabIds: safety.tabIds };
    notify();
    if (locks !== undefined) {
      // Queue a native barrier immediately, so another panel cannot join a shared run before the fence write finishes.
      const durable = new Promise<void>(resolve => {
        quarantineBarriers.add(resolve);
      });
      void (async () => {
        try {
          await locks.request(BROWSER_EXECUTION_LOCK, () => durable);
        } catch {
          safetyError = true;
        }
      })();
    }
    const write = async (): Promise<void> => {
      const persisted = await readSafety();
      safety = {
        ...(locks === undefined || persisted.allTabs === true || safety.allTabs === true
          ? { allTabs: true }
          : {}),
        tabIds: [...new Set([...persisted.tabIds, ...safety.tabIds, ...pendingSafetyTabs])],
        version: 1,
      };
      await storageArea.setItem(BROWSER_EXECUTION_SAFETY_KEY, safety);
      pendingSafetyTabs.delete(tabId);
      safetyRevision += 1;
      if (pendingSafetyTabs.size === 0) {
        for (const resume of quarantineBarriers) {
          resume();
        }
        quarantineBarriers.clear();
      }
    };
    try {
      await (locks === undefined ? write() : locks.request(SAFETY_WRITE_LOCK, write));
    } catch (error) {
      safetyError = true;
      throw error;
    }
  };
  const acquire = (
    kind: BrowserExecutionLease['kind'],
    signal?: AbortSignal,
    authority?: ExecutionGuard
  ): Promise<BrowserAdmission> => {
    const name = kind === 'provider' ? PROVIDER_OWNER_LOCK : BROWSER_EXECUTION_LOCK;
    // eslint-disable-next-line promise/param-names -- Admission and native lock release settle different promises.
    return new Promise(resolveAdmission => {
      // eslint-disable-next-line init-declarations -- The native lease assigns its release callback below.
      let unlock: (() => void) | undefined;
      const held = new Promise<void>(resolve => {
        unlock = resolve;
      });
      let active = true;
      let users = 0;
      let closing = false;
      let releaseReady = false;
      let fencePending = false;
      let fenceFailed = false;
      // eslint-disable-next-line init-declarations -- A normal lease has no quarantine write to await.
      let quarantineWrite: Promise<void> | undefined;
      const guard = (): void => {
        if (!active || closing) {
          throw new ExecutionStoppedError('execution_lease_lost');
        }
        authority?.();
        signal?.throwIfAborted();
        if (kind !== 'provider' && safetyReason() !== undefined) {
          throw new ExecutionStoppedError('profile_quarantined');
        }
      };
      const drain = (): void => {
        if (releaseReady && users === 0 && !fencePending && !fenceFailed) {
          unlock?.();
        }
      };
      const entered = async (lock: Lock | null): Promise<void> => {
        if (lock === null) {
          await refresh();
          resolveAdmission({
            admitted: false,
            reason:
              snapshot.blockedReason ??
              'Browser control is busy. Submit again after control returns.',
          });
          return;
        }
        await refreshInFlight;
        await refresh();
        if (kind !== 'provider' && safetyReason() !== undefined) {
          resolveAdmission({ admitted: false, reason: safetyReason() ?? QUARANTINE_MESSAGE });
          return;
        }
        guard();
        const failedQuarantineTabs = new Set<number>();
        const lease: BrowserExecutionLease = {
          guard,
          kind,
          quarantine: tabId => {
            fencePending = true;
            quarantineWrite = (async () => {
              try {
                await persistQuarantine(tabId);
                failedQuarantineTabs.delete(tabId);
                fenceFailed = failedQuarantineTabs.size > 0;
              } catch (error) {
                fenceFailed = true;
                failedQuarantineTabs.add(tabId);
                failedReleases.add(retryRelease);
                throw error;
              } finally {
                fencePending = false;
                drain();
              }
            })();
            return quarantineWrite;
          },
          release: async () => {
            closing = true;
            // A failed fence write deliberately keeps the native lock held, even after early release.
            await quarantineWrite;
            releaseReady = true;
            drain();
            await released;
            failedReleases.delete(retryRelease);
          },
          run: async work => {
            if (kind === 'provider') {
              throw new ExecutionStoppedError('execution_lease_required');
            }
            guard();
            users += 1;
            try {
              return await work(guard);
            } finally {
              users -= 1;
              drain();
            }
          },
        };
        // The coordinator owns this retry even when the caller discards a failed lease.
        const retryRelease = async (): Promise<void> => {
          if (!closing || users !== 0 || fencePending) {
            return;
          }
          for (const tabId of failedQuarantineTabs) {
            // eslint-disable-next-line no-await-in-loop -- A lease serializes its fence writes before releasing its native lock.
            await lease.quarantine(tabId);
          }
          await lease.release();
        };
        if (kind === 'provider') {
          providerLeases.add(lease);
        }
        resolveAdmission({ admitted: true, lease });
        await held;
      };
      if (locks === undefined) {
        fallbackLocalRuns += 1;
      }
      const request =
        locks === undefined
          ? entered({ mode: 'shared', name })
          : locks.request(
              name,
              {
                ifAvailable: kind !== 'delegated',
                mode: kind === 'local' ? 'shared' : 'exclusive',
                ...(kind === 'delegated' && signal !== undefined ? { signal } : {}),
              },
              entered
            );
      const released = (async () => {
        try {
          await request;
        } catch {
          resolveAdmission({
            admitted: false,
            reason: 'Browser admission stopped. Submit again explicitly.',
          });
        } finally {
          active = false;
          if (locks === undefined) {
            fallbackLocalRuns -= 1;
          }
          await refresh();
        }
      })();
    });
  };
  const withRecoveryLock = async (
    getOpenTabIds: () => Promise<readonly number[]>,
    onReady: () => string | Promise<string>
  ): Promise<BrowserRecoveryReadiness> => {
    try {
      await Promise.all([...failedReleases].map(retry => retry()));
    } catch {
      await refresh();
      return { ready: false, reason: safetyReason() ?? QUARANTINE_MESSAGE };
    }
    if (locks === undefined) {
      // A panel-local counter cannot prove that another panel's issued actions have drained.
      return {
        ready: false,
        reason: `Recovery requires Web Locks. Restore browser Web Locks support before recovering. ${ALL_TABS_RECOVERY_MESSAGE} Browser control remains blocked.`,
      };
    }
    // Recovery never waits behind, steals, or cancels an execution lock.
    const result = await locks.request(
      BROWSER_EXECUTION_LOCK,
      { ifAvailable: true, mode: 'exclusive' },
      async lock => {
        if (lock === null) {
          return {
            ready: false,
            reason: 'Browser actions are still unwinding. Wait before recovery.',
          };
        }
        const record = await readSafety();
        const affected = new Set([...safety.tabIds, ...record.tabIds]);
        const open = await getOpenTabIds();
        if ((record.allTabs === true || safety.allTabs === true) && open.length > 0) {
          return { ready: false, reason: ALL_TABS_RECOVERY_MESSAGE };
        }
        if (open.some(tabId => affected.has(tabId))) {
          return { ready: false, reason: 'Close all affected tabs before recovery.' };
        }
        return { ready: true, reason: await onReady() };
      }
    );
    await refresh();
    return result;
  };
  return {
    /** SessionId must come from the authenticated provider job, never the model's tool arguments. */
    acquireDelegated: async (
      provider: BrowserExecutionLease,
      sessionId: string,
      signal: AbortSignal
    ): Promise<BrowserAdmission> => {
      if (locks === undefined) {
        return { admitted: false, reason: LOCKS_UNAVAILABLE };
      }
      provider.guard();
      if (!providerLeases.has(provider)) {
        return { admitted: false, reason: 'This panel does not own the provider.' };
      }
      await refresh();
      if (delegationPending || snapshot.delegated !== 'idle') {
        return { admitted: false, reason: 'The provider already has delegated work.' };
      }
      if (safetyReason() !== undefined) {
        return { admitted: false, reason: safetyReason() ?? QUARANTINE_MESSAGE };
      }
      delegationPending = true;
      try {
        await storageArea.setItem(OWNER_KEY, {
          sessionId: sessionId.replaceAll(/[^a-zA-Z0-9_-]/gu, '').slice(0, 80),
        });
        provider.guard();
        signal.throwIfAborted();
        const admission = acquire('delegated', signal, provider.guard);
        void refresh();
        return await admission;
      } finally {
        delegationPending = false;
        await refreshInFlight;
        await refresh();
      }
    },
    acquireLocal: async (): Promise<BrowserAdmission> => {
      // Admission must not reuse a query started before a waiter was cancelled.
      await refreshInFlight;
      await refresh();
      if (snapshot.blockedReason !== undefined) {
        return { admitted: false, reason: snapshot.blockedReason };
      }
      return acquire('local');
    },
    acquireProviderOwner: async (): Promise<BrowserAdmission> => {
      const admission: BrowserAdmission =
        locks === undefined
          ? { admitted: false, reason: LOCKS_UNAVAILABLE }
          : await acquire('provider');
      return admission;
    },
    getSnapshot: (): BrowserExecutionSnapshot => snapshot,
    /** Readiness grants no authority; explicit recovery must repeat these checks. */
    prepareRecovery: async (
      getOpenTabIds: () => Promise<readonly number[]>
    ): Promise<BrowserRecoveryReadiness> => {
      try {
        return await withRecoveryLock(
          getOpenTabIds,
          () =>
            'Browser control is ready for recovery. Recover explicitly before submitting new work.'
        );
      } catch {
        await refresh();
        return {
          ready: false,
          reason:
            'Recovery readiness could not be checked. Restore storage and browser access before trying again.',
        };
      }
    },
    recover: async (getOpenTabIds: () => Promise<readonly number[]>): Promise<BrowserRecovery> => {
      const { ready, reason } = await withRecoveryLock(getOpenTabIds, async () => {
        await storageArea.setItem(BROWSER_EXECUTION_SAFETY_KEY, { tabIds: [], version: 1 });
        safetyRevision += 1;
        safety = { tabIds: [], version: 1 };
        safetyError = false;
        // A11 must register a fresh generation before delegated execution.
        return 'Browser control recovered. Submit new work explicitly.';
      });
      return { reason, recovered: ready };
    },
    refresh,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      const onChange = (): void => {
        void refresh();
      };
      const unwatchSafety = storageArea.watch(BROWSER_EXECUTION_SAFETY_KEY, onChange);
      const unwatchOwner = storageArea.watch(OWNER_KEY, onChange);
      // Native locks have no change event. Query also notices a panel disappearing without cleanup.
      const timer = setInterval(onChange, 500);
      onChange();
      return () => {
        clearInterval(timer);
        unwatchSafety();
        unwatchOwner();
        listeners.delete(listener);
      };
    },
  };
};

export type BrowserExecutionCoordinator = ReturnType<typeof createBrowserExecutionCoordinator>;
// eslint-disable-next-line init-declarations -- The first panel creates the shared coordinator.
let coordinator: BrowserExecutionCoordinator | undefined;
export const getBrowserExecutionCoordinator = (): BrowserExecutionCoordinator => {
  coordinator ??= createBrowserExecutionCoordinator({
    locks: globalThis.navigator?.locks,
    storageArea: storage,
  });
  return coordinator;
};
export const useBrowserExecutionSnapshot = (): BrowserExecutionSnapshot => {
  const current = getBrowserExecutionCoordinator();
  return useSyncExternalStore(current.subscribe, current.getSnapshot);
};
