/**
 * App-level owner for the active-sessions live-sync. The owner:
 *
 *  - retains the shared `UserWebConnection` while mounted;
 *  - subscribes to `onSystemEvent` and applies the WS payloads to the
 *    shared `trpc.activeSessions.list` cache through ONE serialized
 *    pipeline (`cancelQueries` + `setQueryData`); the pipeline never
 *    awaits a network fetch, so a stalled tRPC refetch cannot block
 *    later heartbeats;
 *  - requests explicit refreshes (`cli.connected`, `cli.disconnected`,
 *    reconnect, enrichment) through a coalescing `scheduleRefresh` with
 *    durable per-reason pending state. Refreshes call
 *    `queryClient.fetchQuery({ queryKey, queryFn, staleTime: 0 })` so
 *    the network call is forced even after a preceding `setQueryData`.
 *  - observes the connection-state rising edge and triggers exactly
 *    one reconnect refresh per disconnect → connect transition.
 *
 * This module is framework-agnostic: it does not import React or the
 * `UserWebConnectionProvider`. The thin React glue that wires it into the
 * provider lives in `active-sessions-live-sync-mount.tsx`.
 */

import { type QueryClient, type QueryFunction, type QueryKey } from '@tanstack/react-query';

import {
  type CachedActiveSession,
  type CachedActiveSessionsData,
  hasUnenrichedLiveId,
  mergeHeartbeatForActiveSessions,
  mergeSnapshotForActiveSessions,
  parseCliConnectionPayload,
  parseHeartbeatPayload,
  parseSessionsListPayload,
  removeActiveSessionsForConnection,
  selectRootWsSessions,
} from './active-sessions-live';

import { type UserWebConnection, type UserWebSystemEvent } from 'cloud-agent-sdk';

const ENRICHMENT_RETRY_MIN_INTERVAL_MS = 10_000;

type RefreshReason = 'enrichment' | 'cli-connected' | 'cli-disconnected' | 'reconnect';

type SystemEvent = UserWebSystemEvent;

type WriteUpdater = (current: CachedActiveSession[]) => CachedActiveSession[];

/**
 * Minimal contract this owner needs from the SDK. Mirrors the public
 * surface of `UserWebConnection`; the test double in
 * `mobile-session-manager.test.ts` already conforms (see S2).
 */
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

/**
 * The owner as a plain class. Exposed so the test suite can exercise
 * the serialized pipeline, pending-reason state, and reconnect
 * detection without a React renderer.
 */
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

  // Monotonic counters and waiter lists for deterministic test draining.
  // They are only used by getFetchQueue / getFetchCompletion; production
  // behavior does not depend on them.
  private fetchStartCount = 0;
  private fetchStartWaiters: (() => void)[] = [];
  private lastGetFetchQueueCount = 0;
  private fetchCompletionCount = 0;
  private fetchCompletionWaiters: (() => void)[] = [];

  private readonly pendingReasons = new Set<RefreshReason>();
  private inFlightReasons: Set<RefreshReason> | null = null;
  private isFetchInFlight = false;
  private inFlightFetchCanceled = false;
  private lastEnrichmentCompletedAt: number | null = null;
  private lastConnectedState: boolean;

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

  /**
   * Subscribes to WS events, retains the connection, and tracks the
   * initial connection state for the reconnect-rising-edge detector.
   * Returns a detach function that releases all listeners and the
   * retain.
   */
  attach(): () => void {
    if (this.releaseRetain) {
      throw new Error('ActiveSessionsLiveSync already attached');
    }
    // Reset the reconnect detector baseline to the current connection state
    // so re-attach while already connected does not treat it as a rising edge.
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
    this.systemListenerUnsubscribe?.();
    this.connectionListenerUnsubscribe?.();
    this.releaseRetain?.();
    this.systemListenerUnsubscribe = null;
    this.connectionListenerUnsubscribe = null;
    this.releaseRetain = null;
  }

  /** Public for tests / external callers. */
  scheduleRefresh(reason: RefreshReason): void {
    this.pendingReasons.add(reason);
    this.kickFetch();
  }

  /** Exposed for tests so they can drain the write pipeline. */
  async getWriteQueue(): Promise<void> {
    await this.writeQueue;
  }

  /** Exposed for tests so they can drain the fetch pipeline up to the next fetch start. */
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

  /** Exposed for tests so they can drain the current fetch to completion. */
  async getFetchCompletion(): Promise<void> {
    if (!this.isFetchInFlight) {
      return;
    }
    await new Promise<void>(resolve => {
      this.fetchCompletionWaiters.push(resolve);
    });
  }

  /** For tests: read the pending-reason set snapshot. */
  getPendingReasons(): Set<RefreshReason> {
    return new Set(this.pendingReasons);
  }

  /** For tests: read the rate-limit timestamp. */
  getLastEnrichmentCompletedAt(): number | null {
    return this.lastEnrichmentCompletedAt;
  }

  private handleSystemEvent(event: SystemEvent): void {
    if (event.event === 'sessions.list') {
      const sessions = parseSessionsListPayload(event.data);
      if (sessions) {
        const roots = selectRootWsSessions(sessions);
        this.enqueueWrite(current => mergeSnapshotForActiveSessions(current, roots));
      }
      return;
    }
    if (event.event === 'sessions.heartbeat') {
      const payload = parseHeartbeatPayload(event.data);
      if (payload) {
        const roots = selectRootWsSessions(payload.sessions);
        this.enqueueWrite(current =>
          mergeHeartbeatForActiveSessions(current, {
            connectionId: payload.connectionId,
            sessions: roots,
          })
        );
      }
      return;
    }
    if (event.event === 'cli.disconnected') {
      const payload = parseCliConnectionPayload(event.data);
      if (payload) {
        this.enqueueWrite(current =>
          removeActiveSessionsForConnection(current, payload.connectionId)
        );
        this.scheduleRefresh('cli-disconnected');
      }
      return;
    }
    if (event.event === 'cli.connected') {
      this.scheduleRefresh('cli-connected');
    }
  }

  private handleConnectionChange(connected: boolean): void {
    // Rising-edge detector: a false → true transition triggers exactly
    // one reconnect refresh. A true → false transition does not
    // schedule a refresh (the conditional `refetchInterval` covers
    // the WS-down window; re-scheduling here would either duplicate
    // the work or be absorbed by the next refresh regardless).
    if (!this.lastConnectedState && connected) {
      this.scheduleRefresh('reconnect');
    }
    this.lastConnectedState = connected;
  }

  private enqueueWrite(updater: WriteUpdater): void {
    // Serialize ALL cache writes (cancel + setQueryData) on one queue.
    // The pipeline never awaits a network fetch — that is the
    // cancel-based fencing model.
    this.writeQueue = (async () => {
      await this.writeQueue;
      // A write always cancels the in-flight fetch so the new cache
      // state can never be overwritten by a stale result. Record that
      // this cancellation was intentional, so the fetch queue can retry
      // immediately rather than waiting for the next external trigger.
      if (this.isFetchInFlight) {
        this.inFlightFetchCanceled = true;
      }
      await this.queryClient.cancelQueries({ queryKey: this.queryKey });
      this.queryClient.setQueryData<CachedActiveSessionsData>(this.queryKey, current => {
        const existing = current?.sessions ?? [];
        return { sessions: updater(existing) };
      });
      this.maybeScheduleEnrichmentRefresh();
    })();
  }

  private maybeScheduleEnrichmentRefresh(): void {
    const cached = this.queryClient.getQueryData<CachedActiveSessionsData>(this.queryKey);
    const sessions = cached?.sessions ?? [];
    if (!hasUnenrichedLiveId(sessions)) {
      this.pendingReasons.delete('enrichment');
      return;
    }

    // Do not interrupt an in-flight enrichment; it will either succeed or
    // be retried via the normal pending-reason path.
    if (this.isEnrichmentInFlight()) {
      return;
    }

    const now = this.now();
    if (
      this.lastEnrichmentCompletedAt !== null &&
      now - this.lastEnrichmentCompletedAt < ENRICHMENT_RETRY_MIN_INTERVAL_MS
    ) {
      return;
    }

    this.scheduleRefresh('enrichment');
  }

  private isEnrichmentInFlight(): boolean {
    return this.inFlightReasons?.has('enrichment') ?? false;
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
    this.fetchCompletionCount += 1;
    const waiters = this.fetchCompletionWaiters;
    this.fetchCompletionWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private kickFetch(): void {
    // Cancel any in-flight fetch so a newly scheduled refresh can start
    // immediately instead of being queued behind a stale one.
    if (this.isFetchInFlight) {
      // Record that this cancellation was intentional, so the fetch
      // queue can retry immediately rather than waiting for the next
      // external trigger.
      this.inFlightFetchCanceled = true;
      void this.queryClient.cancelQueries({ queryKey: this.queryKey });
    }
    this.fetchQueue = (async () => {
      await this.fetchQueue;
      await this.processFetchQueue();
    })();
  }

  private async processFetchQueue(): Promise<void> {
    if (this.pendingReasons.size === 0) {
      return;
    }
    if (this.isFetchInFlight) {
      return;
    }
    this.isFetchInFlight = true;
    // Reset the cancellation flag for THIS fetch instance. Any cancel
    // that targets this fetch will set it back to true before the catch.
    this.inFlightFetchCanceled = false;
    const inFlightReasons = new Set(this.pendingReasons);
    this.inFlightReasons = inFlightReasons;
    let success = false;
    try {
      await this.queryClient.cancelQueries({ queryKey: this.queryKey });
      // fetchQuery with staleTime: 0 forces a network call regardless
      // of any preceding setQueryData.
      const fetchPromise = this.queryClient.fetchQuery({
        queryKey: this.queryKey,
        queryFn: this.queryFn,
        staleTime: 0,
      });
      // The fetch is now in flight: let tests waiting on getFetchQueue()
      // observe the pending state and/or issue cancellations.
      this.notifyFetchStart();
      await fetchPromise;
      success = true;
    } catch {
      // Either the query was canceled by a later WS write, or the
      // network call itself failed. In either case, the reasons stay
      // pending so a future scheduleRefresh (or the trailing
      // re-kick) re-attempts.
    } finally {
      this.isFetchInFlight = false;
    }
    if (success) {
      for (const r of inFlightReasons) {
        this.pendingReasons.delete(r);
      }
      if (inFlightReasons.has('enrichment')) {
        this.lastEnrichmentCompletedAt = this.now();
      }
    }
    // An enrichment reason is only meaningful while the cache still has
    // at least one unenriched live id. If it left or enriched, drop the
    // stale reason so it cannot drive pointless retries.
    if (this.pendingReasons.has('enrichment')) {
      const cached = this.queryClient.getQueryData<CachedActiveSessionsData>(this.queryKey);
      if (!hasUnenrichedLiveId(cached?.sessions ?? [])) {
        this.pendingReasons.delete('enrichment');
      }
    }
    const hasNewReasons = [...this.pendingReasons].some(reason => !inFlightReasons.has(reason));
    // Read via helper so control-flow analysis does not treat the field as
    // stuck at the `false` written above — other methods flip it during await.
    const wasCanceled = this.readInFlightFetchCanceled();
    this.inFlightReasons = null;
    // Signal completion (success or failure) so tests waiting on
    // getFetchCompletion() can inspect the updated state.
    this.notifyFetchCompletion();
    // Re-kick immediately only when a replacement fetch is genuinely
    // warranted: either the in-flight fetch was intentionally canceled by
    // newer work, or new reasons were raised while it was in flight. On a
    // genuine failure without either condition, stay quiet and let the
    // next scheduled trigger (WS event / fallback poll) retry.
    if (this.pendingReasons.size > 0 && (wasCanceled || hasNewReasons)) {
      this.kickFetch();
    }
  }

  private readInFlightFetchCanceled(): boolean {
    return this.inFlightFetchCanceled;
  }
}
