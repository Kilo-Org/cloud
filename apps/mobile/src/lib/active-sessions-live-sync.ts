/** Serialized socket writes and accepted server refreshes for one tray scope. */
import {
  hashKey,
  type QueryClient,
  type QueryFunction,
  type QueryKey,
} from '@tanstack/react-query';
import { type UserWebConnection, type UserWebSystemEvent } from '@kilocode/cloud-agent-sdk';

import {
  type CachedActiveSession,
  type CachedActiveSessionsData,
  hasUnenrichedLiveId,
  planLiveSystemEventActions,
} from './active-sessions-live';
import { currentAuthEpoch, isCurrentAuthEpoch } from './auth/auth-epoch';
import { isSignOutActive } from './auth/sign-out-state';
import { captureActiveSessionsQueryRefresh, fenceActiveSessionsQuery } from './query-client';

const ENRICHMENT_RETRY_MIN_INTERVAL_MS = 10_000;
type RefreshReason = 'enrichment' | 'cli-connected' | 'cli-disconnected' | 'reconnect' | 'manual';
type WriteUpdater = (current: CachedActiveSession[]) => CachedActiveSession[];
export type LiveSyncConnection = Pick<
  UserWebConnection,
  'retain' | 'isConnected' | 'onConnectionChange' | 'onSystemEvent'
>;
export type LiveSyncQueryClient = QueryClient;
type CreateLiveSyncOptions = {
  connection: LiveSyncConnection;
  queryClient: LiveSyncQueryClient;
  queryKey: QueryKey;
  queryFn: QueryFunction<CachedActiveSessionsData>;
  now?: () => number;
};

export class ActiveSessionsLiveSync {
  private readonly now: () => number;
  // eslint-disable-next-line promise/prefer-await-to-then
  private writeQueue: Promise<void> = Promise.resolve();
  // eslint-disable-next-line promise/prefer-await-to-then
  private fetchQueue: Promise<void> = Promise.resolve();
  private fetchStartCount = 0;
  private readonly fetchStartWaiters: (() => void)[] = [];
  private lastGetFetchQueueCount = 0;
  private readonly fetchCompletionWaiters: (() => void)[] = [];
  private readonly pendingReasons = new Set<RefreshReason>();
  private inFlightReasons: Set<RefreshReason> | null = null;
  private isFetchInFlight = false;
  private inFlightFetchCanceled = false;
  private lastEnrichmentAttemptAt: number | null = null;
  private lastConnectedState: boolean;
  private attachmentEpoch = 0;
  private authEpoch = currentAuthEpoch();
  private releaseRetain: (() => void) | null = null;
  private systemListenerUnsubscribe: (() => void) | null = null;
  private connectionListenerUnsubscribe: (() => void) | null = null;

  private readonly options: CreateLiveSyncOptions;

  constructor(options: CreateLiveSyncOptions) {
    // Copy the inputs so a caller cannot retarget this owner by changing them.
    this.options = { ...options };
    this.now = options.now ?? (() => Date.now());
    this.lastConnectedState = options.connection.isConnected();
  }

  attach(): () => void {
    if (this.releaseRetain) {
      throw new Error('ActiveSessionsLiveSync already attached');
    }
    this.attachmentEpoch += 1;
    this.authEpoch = currentAuthEpoch();
    const { connection } = this.options;
    // Re-attachment while connected must not look like a rising edge.
    this.lastConnectedState = connection.isConnected();
    this.releaseRetain = connection.retain();
    // eslint-disable-next-line typescript-eslint/no-this-alias, unicorn/no-this-assignment
    attachedSync = this;
    this.systemListenerUnsubscribe = connection.onSystemEvent(event => {
      this.handleSystemEvent(event);
    });
    this.connectionListenerUnsubscribe = connection.onConnectionChange(connected => {
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
    if (attachedSync === this) {
      attachedSync = null;
    }
    void this.options.queryClient.cancelQueries({ queryKey: this.options.queryKey, exact: true });
  }

  private isCurrentAttachment(epoch: number): boolean {
    const isAttached = this.releaseRetain !== null && epoch === this.attachmentEpoch;
    return isAttached && isCurrentAuthEpoch(this.authEpoch) && !isSignOutActive();
  }

  scheduleRefresh(reason: RefreshReason): void {
    if (!this.isCurrentAttachment(this.attachmentEpoch)) {
      return;
    }
    this.pendingReasons.add(reason);
    this.kickFetch();
  }

  /** False selects a caller fallback; handled failures must not start another fetch. */
  async refreshNow(queryKey: QueryKey): Promise<false | { accepted: boolean }> {
    const epoch = this.attachmentEpoch;
    if (!this.isCurrentAttachment(epoch) || hashKey(queryKey) !== hashKey(this.options.queryKey)) {
      return false;
    }
    const refresh = captureActiveSessionsQueryRefresh(this.options.queryClient, queryKey);
    this.scheduleRefresh('manual');
    // Cached-data cancellation can fulfill. Follow the replacement fetches.
    /* eslint-disable no-await-in-loop */
    while (this.pendingReasons.has('manual') && this.isCurrentAttachment(epoch)) {
      const queue = this.fetchQueue;
      await queue;
      if (this.fetchQueue === queue) {
        break;
      }
    }
    /* eslint-enable no-await-in-loop */
    return {
      accepted:
        this.isCurrentAttachment(epoch) &&
        !this.pendingReasons.has('manual') &&
        refresh.hasAcceptedResult(),
    };
  }

  async getWriteQueue(): Promise<void> {
    await this.writeQueue;
  }

  async getFetchQueue(): Promise<void> {
    if (this.pendingReasons.size === 0) {
      return;
    }
    if (this.fetchStartCount <= this.lastGetFetchQueueCount) {
      await new Promise<void>(resolve => {
        this.fetchStartWaiters.push(resolve);
      });
    }
    this.lastGetFetchQueueCount = this.fetchStartCount;
  }

  async getFetchCompletion(): Promise<void> {
    if (this.isFetchInFlight) {
      await new Promise<void>(resolve => {
        this.fetchCompletionWaiters.push(resolve);
      });
    }
  }

  getPendingReasons(): Set<RefreshReason> {
    return new Set(this.pendingReasons);
  }

  private handleSystemEvent(event: UserWebSystemEvent): void {
    for (const action of planLiveSystemEventActions(event)) {
      if (action.type === 'write') {
        this.enqueueWrite(action.updater);
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
    if (!this.isCurrentAttachment(this.attachmentEpoch)) {
      return;
    }
    const attachmentEpoch = this.attachmentEpoch;
    const { queryClient, queryKey } = this.options;
    // Serialized cancel+setQueryData; never awaits network.
    this.writeQueue = (async () => {
      await this.writeQueue;
      if (!this.isCurrentAttachment(attachmentEpoch)) {
        return;
      }
      if (this.isFetchInFlight) {
        this.inFlightFetchCanceled = true;
      }
      await queryClient.cancelQueries({ queryKey, exact: true });
      if (!this.isCurrentAttachment(attachmentEpoch)) {
        return;
      }
      queryClient.setQueryData<CachedActiveSessionsData>(queryKey, current => ({
        sessions: updater(current?.sessions ?? []),
      }));
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
    const { queryClient, queryKey } = this.options;
    const cachedSessions =
      queryClient.getQueryData<CachedActiveSessionsData>(queryKey)?.sessions ?? [];
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
    for (const resolve of this.fetchStartWaiters.splice(0)) {
      resolve();
    }
  }

  private notifyFetchCompletion(): void {
    for (const resolve of this.fetchCompletionWaiters.splice(0)) {
      resolve();
    }
  }

  private kickFetch(): void {
    if (!this.isCurrentAttachment(this.attachmentEpoch)) {
      return;
    }
    const attachmentEpoch = this.attachmentEpoch;
    if (this.isFetchInFlight) {
      this.inFlightFetchCanceled = true;
      void this.options.queryClient.cancelQueries({ queryKey: this.options.queryKey, exact: true });
    }
    this.fetchQueue = (async () => {
      await this.fetchQueue;
      await this.processFetchQueue(attachmentEpoch);
    })();
  }

  private async processFetchQueue(attachmentEpoch: number): Promise<void> {
    // Start a replacement after the write that canceled its predecessor.
    await this.writeQueue;
    const canFetch = this.pendingReasons.size > 0 && !this.isFetchInFlight;
    if (!canFetch || !this.isCurrentAttachment(attachmentEpoch)) {
      return;
    }
    this.isFetchInFlight = true;
    this.inFlightFetchCanceled = false;
    const inFlightReasons = new Set(this.pendingReasons);
    this.inFlightReasons = inFlightReasons;
    const { queryClient, queryKey, queryFn } = this.options;
    const refresh = captureActiveSessionsQueryRefresh(queryClient, queryKey);
    let success = false;
    try {
      await queryClient.cancelQueries({ queryKey, exact: true });
      if (this.isCurrentAttachment(attachmentEpoch) && refresh.isCurrent()) {
        const fetchPromise = queryClient.fetchQuery({
          queryKey,
          queryFn: fenceActiveSessionsQuery(queryFn, () =>
            this.isCurrentAttachment(attachmentEpoch)
          ),
          staleTime: 0,
        });
        this.notifyFetchStart();
        await fetchPromise;
        success = !this.readInFlightFetchCanceled() && refresh.hasAcceptedResult();
      }
    } catch {
      // Cancellation and network failure keep reasons pending for Retry.
    } finally {
      this.isFetchInFlight = false;
    }
    if (!this.isCurrentAttachment(attachmentEpoch)) {
      this.inFlightReasons = null;
      this.notifyFetchCompletion();
      return;
    }
    if (inFlightReasons.has('enrichment')) {
      this.lastEnrichmentAttemptAt = this.now();
    }
    if (success) {
      for (const reason of inFlightReasons) {
        this.pendingReasons.delete(reason);
      }
      this.updateEnrichmentReason();
    }
    const hasNewReasons = [...this.pendingReasons].some(reason => !inFlightReasons.has(reason));
    const wasCanceled = this.readInFlightFetchCanceled();
    this.inFlightReasons = null;
    this.notifyFetchCompletion();
    if (this.pendingReasons.size > 0 && (wasCanceled || hasNewReasons)) {
      this.kickFetch();
    }
  }

  private readInFlightFetchCanceled(): boolean {
    return this.inFlightFetchCanceled;
  }
}

/** One app-level mount owns the registry and socket lease. */
let attachedSync: ActiveSessionsLiveSync | null = null;

export const refreshActiveSessionsFromPush = (): void => attachedSync?.scheduleRefresh('manual');

/** Returns false if no current owner handles this exact key. */
export async function refreshActiveSessionsNow(
  queryKey: QueryKey
): Promise<false | { accepted: boolean }> {
  return (await attachedSync?.refreshNow(queryKey)) ?? false;
}
