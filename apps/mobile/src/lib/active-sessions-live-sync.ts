/**
 * App-level owner for active-sessions live-sync: retains UserWebConnection,
 * applies onSystemEvent payloads to trpc.activeSessions.list via a serialized
 * cancelQueries+setQueryData pipeline, and coalesces refreshes (cli.connected /
 * disconnected, reconnect, enrichment) with fetchQuery staleTime:0.
 * Framework-agnostic; React glue is active-sessions-live-sync-mount.tsx.
 */

import { type QueryClient, type QueryFunction, type QueryKey } from '@tanstack/react-query';

import {
  type CachedActiveSession,
  type CachedActiveSessionsData,
  hasUnenrichedLiveId,
  planLiveSystemEventActions,
} from './active-sessions-live';

import { type UserWebConnection, type UserWebSystemEvent } from 'cloud-agent-sdk';

const ENRICHMENT_RETRY_MIN_INTERVAL_MS = 10_000;

type RefreshReason = 'enrichment' | 'cli-connected' | 'cli-disconnected' | 'reconnect';

type SystemEvent = UserWebSystemEvent;

type WriteUpdater = (current: CachedActiveSession[]) => CachedActiveSession[];

/** Minimal UserWebConnection surface used by this owner. */
export type LiveSyncConnection = Pick<
  UserWebConnection,
  'retain' | 'isConnected' | 'onConnectionChange' | 'onSystemEvent'
>;

export type LiveSyncQueryClient = Pick<
  QueryClient,
  'cancelQueries' | 'setQueryData' | 'getQueryData' | 'fetchQuery'
>;

type CreateLiveSyncOptions = {
  connection: LiveSyncConnection;
  queryClient: LiveSyncQueryClient;
  queryKey: QueryKey;
  queryFn: QueryFunction<CachedActiveSessionsData>;
  now?: () => number;
};

/** Testable owner: serialized pipeline, pending reasons, reconnect edge. */
export class ActiveSessionsLiveSync {
  private readonly connection: LiveSyncConnection;
  private readonly queryClient: LiveSyncQueryClient;
  private readonly queryKey: QueryKey;
  private readonly queryFn: QueryFunction<CachedActiveSessionsData>;
  private readonly now: () => number;

  // eslint-disable-next-line promise/prefer-await-to-then
  private writeQueue: Promise<void> = Promise.resolve();
  // eslint-disable-next-line promise/prefer-await-to-then
  private fetchQueue: Promise<void> = Promise.resolve();

  private fetchStartCount = 0;
  private fetchStartWaiters: (() => void)[] = [];
  private lastGetFetchQueueCount = 0;
  private fetchCompletionWaiters: (() => void)[] = [];

  private readonly pendingReasons = new Set<RefreshReason>();
  private inFlightReasons: Set<RefreshReason> | null = null;
  private isFetchInFlight = false;
  private inFlightFetchCanceled = false;
  private lastEnrichmentAttemptAt: number | null = null;
  private lastConnectedState: boolean;
  private attachmentEpoch = 0;

  private releaseRetain: (() => void) | null = null;
  private systemListenerUnsubscribe: (() => void) | null = null;
  private connectionListenerUnsubscribe: (() => void) | null = null;

  constructor(options: CreateLiveSyncOptions) {
    this.connection = options.connection;
    this.queryClient = options.queryClient;
    this.queryKey = options.queryKey;
    this.queryFn = options.queryFn;
    this.now = options.now ?? (() => Date.now());
    this.lastConnectedState = this.connection.isConnected();
  }

  /** Subscribe, retain; detach releases listeners + retain. */
  attach(): () => void {
    if (this.releaseRetain) {
      throw new Error('ActiveSessionsLiveSync already attached');
    }
    // Re-attach while connected must not look like a rising edge.
    this.attachmentEpoch += 1;
    this.lastConnectedState = this.connection.isConnected();
    this.releaseRetain = this.connection.retain();
    this.systemListenerUnsubscribe = this.connection.onSystemEvent(event => {
      this.handleSystemEvent(event);
    });
    this.connectionListenerUnsubscribe = this.connection.onConnectionChange(connected => {
      this.handleConnectionChange(connected);
    });
    return () => {
      this.detach();
    };
  }

  detach(): void {
    this.attachmentEpoch += 1;
    this.pendingReasons.clear();
    this.systemListenerUnsubscribe?.();
    this.connectionListenerUnsubscribe?.();
    this.releaseRetain?.();
    this.systemListenerUnsubscribe = null;
    this.connectionListenerUnsubscribe = null;
    this.releaseRetain = null;
    void this.queryClient.cancelQueries({ queryKey: this.queryKey });
  }

  scheduleRefresh(reason: RefreshReason): void {
    if (this.releaseRetain === null) {
      return;
    }
    this.pendingReasons.add(reason);
    this.kickFetch();
  }

  async getWriteQueue(): Promise<void> {
    await this.writeQueue;
  }

  async getFetchQueue(): Promise<void> {
    if (this.pendingReasons.size === 0) {
      return;
    }
    if (this.fetchStartCount > this.lastGetFetchQueueCount) {
      this.lastGetFetchQueueCount = this.fetchStartCount;
      return;
    }
    await new Promise<void>(resolve => {
      this.fetchStartWaiters.push(resolve);
    });
    this.lastGetFetchQueueCount = this.fetchStartCount;
  }

  async getFetchCompletion(): Promise<void> {
    if (!this.isFetchInFlight) {
      return;
    }
    await new Promise<void>(resolve => {
      this.fetchCompletionWaiters.push(resolve);
    });
  }

  getPendingReasons(): Set<RefreshReason> {
    return new Set(this.pendingReasons);
  }

  private handleSystemEvent(event: SystemEvent): void {
    for (const action of planLiveSystemEventActions(event)) {
      if (action.type === 'write') {
        this.enqueueWrite(current => action.updater(current));
      } else {
        this.scheduleRefresh(action.reason);
      }
    }
  }

  private handleConnectionChange(connected: boolean): void {
    // Rising edge only; disconnect relies on refetchInterval.
    if (!this.lastConnectedState && connected) {
      this.scheduleRefresh('reconnect');
    }
    this.lastConnectedState = connected;
  }

  private enqueueWrite(updater: WriteUpdater): void {
    if (this.releaseRetain === null) {
      return;
    }
    const attachmentEpoch = this.attachmentEpoch;
    // Serialized cancel+setQueryData; never awaits network.
    this.writeQueue = (async () => {
      await this.writeQueue;
      if (attachmentEpoch !== this.attachmentEpoch) {
        return;
      }
      // Cancel in-flight fetch so stale results cannot overwrite.
      if (this.isFetchInFlight) {
        this.inFlightFetchCanceled = true;
      }
      await this.queryClient.cancelQueries({ queryKey: this.queryKey });
      if (attachmentEpoch !== this.attachmentEpoch) {
        return;
      }
      this.queryClient.setQueryData<CachedActiveSessionsData>(this.queryKey, current => {
        const existing = current?.sessions ?? [];
        return { sessions: updater(existing) };
      });
      this.maybeScheduleEnrichmentRefresh();
    })();
  }

  private maybeScheduleEnrichmentRefresh(): void {
    this.updateEnrichmentReason();
    if (this.pendingReasons.has('enrichment') && !this.inFlightReasons?.has('enrichment')) {
      this.kickFetch();
    }
  }

  private updateEnrichmentReason(): void {
    const cachedSessions =
      this.queryClient.getQueryData<CachedActiveSessionsData>(this.queryKey)?.sessions ?? [];
    if (!hasUnenrichedLiveId(cachedSessions)) {
      this.pendingReasons.delete('enrichment');
      return;
    }
    if (this.inFlightReasons?.has('enrichment')) {
      return;
    }
    const due =
      this.lastEnrichmentAttemptAt === null ||
      this.now() - this.lastEnrichmentAttemptAt >= ENRICHMENT_RETRY_MIN_INTERVAL_MS;
    if (due) {
      this.pendingReasons.add('enrichment');
    } else {
      this.pendingReasons.delete('enrichment');
    }
  }

  private notifyFetchStart(): void {
    this.fetchStartCount += 1;
    const waiters = this.fetchStartWaiters;
    this.fetchStartWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private notifyFetchCompletion(): void {
    const waiters = this.fetchCompletionWaiters;
    this.fetchCompletionWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private kickFetch(): void {
    if (this.releaseRetain === null) {
      return;
    }
    const attachmentEpoch = this.attachmentEpoch;
    // Cancel in-flight fetch so a new refresh starts immediately.
    if (this.isFetchInFlight) {
      this.inFlightFetchCanceled = true;
      void this.queryClient.cancelQueries({ queryKey: this.queryKey });
    }
    this.fetchQueue = (async () => {
      await this.fetchQueue;
      await this.processFetchQueue(attachmentEpoch);
    })();
  }

  private async processFetchQueue(attachmentEpoch: number): Promise<void> {
    if (attachmentEpoch !== this.attachmentEpoch || this.pendingReasons.size === 0) {
      return;
    }
    if (this.isFetchInFlight) {
      return;
    }
    this.isFetchInFlight = true;
    this.inFlightFetchCanceled = false;
    const inFlightReasons = new Set(this.pendingReasons);
    this.inFlightReasons = inFlightReasons;
    let success = false;
    try {
      await this.queryClient.cancelQueries({ queryKey: this.queryKey });
      if (attachmentEpoch === this.attachmentEpoch) {
        // staleTime:0 forces a network call after setQueryData.
        const fetchPromise = this.queryClient.fetchQuery({
          queryKey: this.queryKey,
          queryFn: this.queryFn,
          staleTime: 0,
        });
        this.notifyFetchStart();
        await fetchPromise;
        success = true;
      }
    } catch {
      // Canceled or network failure: keep reasons pending for retry.
    } finally {
      this.isFetchInFlight = false;
    }
    if (attachmentEpoch !== this.attachmentEpoch) {
      this.inFlightReasons = null;
      this.notifyFetchCompletion();
      return;
    }
    if (inFlightReasons.has('enrichment')) {
      this.lastEnrichmentAttemptAt = this.now();
    }
    if (success) {
      for (const r of inFlightReasons) {
        this.pendingReasons.delete(r);
      }
      this.updateEnrichmentReason();
    }
    const hasNewReasons = [...this.pendingReasons].some(reason => !inFlightReasons.has(reason));
    // Helper so CFA does not treat the field as stuck at false after await.
    const wasCanceled = this.readInFlightFetchCanceled();
    this.inFlightReasons = null;
    this.notifyFetchCompletion();
    // Re-kick only after intentional cancel or new reasons mid-flight.
    if (this.pendingReasons.size > 0 && (wasCanceled || hasNewReasons)) {
      this.kickFetch();
    }
  }

  private readInFlightFetchCanceled(): boolean {
    return this.inFlightFetchCanceled;
  }
}
