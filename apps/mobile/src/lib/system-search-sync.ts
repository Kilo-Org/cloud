/**
 * One owner that keeps the phone's own search index equal to the documents the
 * app already holds.
 *
 * It is event-driven: `attach()` subscribes to the react-query cache, coalesces
 * a burst of cache writes behind a trailing debounce, and each run re-plans
 * from the cache. Nothing here fetches — `collect` reads what the app already
 * has — so an index refresh never starts network work.
 *
 * The shape follows `ActiveSessionsLiveSync`: `attach()` takes the
 * subscription and returns the detach, and every run is serialized so two runs
 * never race the native ledger.
 */
import { type QueryClient } from '@tanstack/react-query';

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { isSystemSearchAvailable } from '@/lib/native-system-search';
import { type SystemSearchCollection } from '@/lib/system-search-collect';
import { planSystemSearchUpdate, type SystemSearchDocument } from '@/lib/system-search-entries';

/** How long a burst of cache writes coalesces before one sync runs. */
const SYSTEM_SEARCH_SYNC_COALESCE_MS = 750;

/**
 * The longest a burst may postpone a sync. A sustained stream of cache writes
 * faster than the coalesce window — the streaming transcript writing to the
 * same client through a long turn — would otherwise re-arm the trailing timer
 * forever and leave the index stale until the stream stopped.
 */
const SYSTEM_SEARCH_SYNC_MAX_WAIT_MS = 5000;

/** The index delta one sync applies, in the shape the native bridge takes. */
export type SystemSearchIndexUpdate = {
  add: SystemSearchDocument[];
  remove: string[];
};

export type SystemSearchSyncDeps = {
  queryClient: QueryClient;
  collect: () => Promise<SystemSearchCollection>;
  fingerprints: () => Promise<Record<string, string>>;
  apply: (update: SystemSearchIndexUpdate) => Promise<void>;
  report: (error: unknown) => void;
  isEnabled: () => boolean;
};

export type SystemSearchSyncResult = 'applied' | 'skipped' | 'failed';

/**
 * The production gate: a dev client built before the native module shipped has
 * no system search at all, and an in-flight sign-out teardown must never
 * re-index the account it is clearing.
 */
export function isSystemSearchSyncEnabled(): boolean {
  return isSystemSearchAvailable && !isSignOutActive();
}

/**
 * The indexed ledger in the plan's document shape. Only `id` and `fingerprint`
 * are compared, so the content fields and the route are empty here on purpose.
 */
function indexedDocuments(fingerprints: Record<string, string>): SystemSearchDocument[] {
  return Object.entries(fingerprints).map(([id, fingerprint]) => ({
    id,
    title: '',
    description: '',
    keywords: [],
    route: '',
    fingerprint,
  }));
}

export class SystemSearchIndexSync {
  private readonly deps: SystemSearchSyncDeps;
  private detachCacheSubscription: (() => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceWindowStartedAt: number | null = null;
  private runQueue: Promise<void> | null = null;

  constructor(deps: SystemSearchSyncDeps) {
    // Copy the inputs so a caller cannot retarget this owner by changing them.
    this.deps = { ...deps };
  }

  /** Takes the cache subscription and returns the one detach for this owner. */
  attach(): () => void {
    if (this.detachCacheSubscription !== null) {
      throw new Error('SystemSearchIndexSync already attached');
    }
    // Every cache event only re-arms the debounce; the sync reads the cache
    // itself, so an event payload is never needed.
    this.detachCacheSubscription = this.deps.queryClient.getQueryCache().subscribe(() => {
      this.schedule();
    });
    return () => {
      this.detach();
    };
  }

  detach(): void {
    this.detachCacheSubscription?.();
    this.detachCacheSubscription = null;
    this.debounceWindowStartedAt = null;
    this.clearDebounce();
  }

  /**
   * One sync: gate, collect, diff against the indexed ledger, apply.
   *
   * `applied` only when the native call accepted the delta; `skipped` when the
   * sync is disabled, the plan is empty, or the run's account transitioned
   * while it was collecting, and then the native call is never made; `failed`
   * after a single report, with the ledger left untouched so the next trigger
   * re-plans the same delta. Never rejects.
   */
  async syncNow(): Promise<SystemSearchSyncResult> {
    const previous = this.runQueue;
    let result: SystemSearchSyncResult = 'skipped';
    const run = (async () => {
      // At most one sync at a time: a run never overlaps its predecessor.
      if (previous !== null) {
        await previous;
      }
      result = await this.performSync();
    })();
    this.runQueue = run;
    await run;
    return result;
  }

  /** Resolves when every sync scheduled so far has settled. */
  async getRunQueue(): Promise<void> {
    const queue = this.runQueue;
    if (queue !== null) {
      await queue;
    }
  }

  private schedule(): void {
    if (this.detachCacheSubscription === null) {
      return;
    }
    const now = Date.now();
    const windowStartedAt = this.debounceWindowStartedAt ?? now;
    const waited = now - windowStartedAt;
    // A burst cannot postpone the sync past the maximum wait: once the window
    // is older than it, run now and start a fresh window rather than re-arm.
    if (waited >= SYSTEM_SEARCH_SYNC_MAX_WAIT_MS) {
      this.clearDebounce();
      this.debounceWindowStartedAt = now;
      void this.syncNow();
      return;
    }
    // Trailing debounce: a burst re-arms the same timer and runs once, but the
    // timer never reaches past the maximum-wait deadline.
    this.debounceWindowStartedAt = windowStartedAt;
    this.clearDebounce();
    this.debounceTimer = setTimeout(
      () => {
        this.debounceTimer = null;
        this.debounceWindowStartedAt = null;
        void this.syncNow();
      },
      Math.min(SYSTEM_SEARCH_SYNC_COALESCE_MS, SYSTEM_SEARCH_SYNC_MAX_WAIT_MS - waited)
    );
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async performSync(): Promise<SystemSearchSyncResult> {
    try {
      // The run's own fence, captured before its first await: a sign-out or a
      // newer sign-in moves the auth epoch, and the re-read before the write
      // then refuses this run's documents. The gate is inside the try so a
      // dependency that throws resolves to `failed` instead of rejecting
      // `syncNow` at its fire-and-forget call sites (the coalescing timer and
      // the mount).
      const epoch = currentAuthEpoch();
      if (!this.deps.isEnabled()) {
        return 'skipped';
      }
      const documents = await this.deps.collect();
      const plan = planSystemSearchUpdate({
        indexed: indexedDocuments(await this.deps.fingerprints()),
        documents: documents.documents,
        observedSources: documents.observedSources,
      });
      if (plan.add.length === 0 && plan.remove.length === 0) {
        return 'skipped';
      }
      // Both fences are read again after the awaits and immediately before the
      // write, with no await in between. The collects above can outlive a
      // sign-out, whose teardown fires the native clear: writing this run's
      // documents then would put the outgoing account's entries back into the
      // index after it was wiped. The flag covers the teardown window (where
      // the epoch has not moved yet); the epoch covers a sign-out that finished
      // or an account switch that landed during the collects, whose own clear
      // must not be undone by this run's now-stale plan either.
      if (!isCurrentAuthEpoch(epoch) || !this.deps.isEnabled()) {
        return 'skipped';
      }
      await this.deps.apply({ add: plan.add, remove: plan.remove });
      return 'applied';
    } catch (error) {
      // The native ledger advances only on success, so the next trigger
      // re-plans the same delta. Never log a document id or a title.
      try {
        this.deps.report(error);
      } catch {
        // `syncNow` never rejects, so a broken reporter must not become an
        // unhandled rejection; the ledger is unchanged and the next trigger
        // retries either way.
      }
      return 'failed';
    }
  }
}
