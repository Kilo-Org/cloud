import type { SessionUpdatedMetadataMessage } from '@kilocode/session-ingest-contracts';
import type { Env } from '../types.js';
import type { KiloGlobalEventEnvelope } from './handlers/global-feed-upgrade/message.js';
import { projectPublicSession, publicCloudAgentDirectory } from './public-sdk-projection.js';

const SNAPSHOT_RETRY_DELAY_MS = 100;
const MAX_TRACKED_SESSION_VERSIONS = 256;
const MAX_TRACKED_SESSION_REFRESHES = 256;
const MAX_CONCURRENT_SESSION_REFRESHES = 8;

type Broadcast = (event: KiloGlobalEventEnvelope, kiloSessionId: string) => void;
type IsCurrent = (generation: number) => boolean;

type SessionVersion = {
  updated: number;
  fingerprint: string;
  source: 'wrapper' | 'canonical';
};

type RefreshState = {
  running: boolean;
  dirty: boolean;
  hasSlot: boolean;
  generation: number;
  retries: number;
  timer?: ReturnType<typeof setTimeout>;
};

function sessionUpdatedInfo(
  event: KiloGlobalEventEnvelope
): { updated: number; info: unknown } | null {
  const payload = event.payload;
  if (payload?.type !== 'session.updated') return null;
  const properties = payload.properties;
  if (!properties || typeof properties !== 'object') return null;
  const info: unknown = Reflect.get(properties, 'info');
  if (!info || typeof info !== 'object') return null;
  const time: unknown = Reflect.get(info, 'time');
  if (!time || typeof time !== 'object') return null;
  const updated: unknown = Reflect.get(time, 'updated');
  return typeof updated === 'number' && Number.isFinite(updated) ? { updated, info } : null;
}

export class FacadeMetadataProjector {
  private versions = new Map<string, SessionVersion>();
  private refreshes = new Map<string, RefreshState>();
  private pendingRefreshes = new Set<string>();
  private activeRefreshes = 0;
  private lifecycleGeneration = 0;
  private currentUserId = '';

  constructor(
    private readonly env: Env,
    private readonly broadcast: Broadcast,
    private readonly isCurrent: IsCurrent
  ) {}

  start(generation: number, userId: string): void {
    this.lifecycleGeneration = generation;
    this.currentUserId = userId;
  }

  stop(): void {
    this.lifecycleGeneration += 1;
    this.currentUserId = '';
    for (const refresh of this.refreshes.values()) {
      if (refresh.timer) clearTimeout(refresh.timer);
    }
    this.refreshes.clear();
    this.pendingRefreshes.clear();
    this.activeRefreshes = 0;
    this.versions.clear();
  }

  recordWrapperEvent(event: KiloGlobalEventEnvelope, kiloSessionId: string): boolean {
    if (!this.isActive(this.lifecycleGeneration)) return true;
    const update = sessionUpdatedInfo(event);
    if (!update) return true;

    const refresh = this.refreshes.get(kiloSessionId);
    if (refresh) {
      this.supersedeRefresh(
        kiloSessionId,
        this.lifecycleGeneration,
        refresh,
        refresh.generation + 1
      );
    }

    const fingerprint = JSON.stringify(update.info);
    const latest = this.versions.get(kiloSessionId);
    if (latest && update.updated < latest.updated) {
      this.rememberVersion(kiloSessionId, latest);
      return false;
    }
    if (
      latest &&
      update.updated === latest.updated &&
      (latest.fingerprint === fingerprint || latest.source === 'canonical')
    ) {
      this.rememberVersion(kiloSessionId, latest);
      return false;
    }

    this.rememberVersion(kiloSessionId, {
      updated: update.updated,
      fingerprint,
      source: 'wrapper',
    });
    return true;
  }

  notify(message: SessionUpdatedMetadataMessage, generation: number): void {
    this.requestRefresh(message.data.session.sessionId, generation);
  }

  reconcile(kiloSessionIds: Iterable<string>, generation: number): void {
    for (const kiloSessionId of new Set(kiloSessionIds)) {
      this.requestRefresh(kiloSessionId, generation);
    }
  }

  private requestRefresh(kiloSessionId: string, lifecycleGeneration: number): void {
    if (!this.isActive(lifecycleGeneration)) return;
    const current = this.refreshes.get(kiloSessionId);
    if (current) {
      this.supersedeRefresh(kiloSessionId, lifecycleGeneration, current, current.generation + 1);
      return;
    }
    if (this.refreshes.size >= MAX_TRACKED_SESSION_REFRESHES) return;

    const refresh: RefreshState = {
      running: false,
      dirty: true,
      hasSlot: false,
      generation: 1,
      retries: 0,
    };
    this.refreshes.set(kiloSessionId, refresh);
    this.scheduleRefresh(kiloSessionId, lifecycleGeneration, refresh);
  }

  private supersedeRefresh(
    kiloSessionId: string,
    lifecycleGeneration: number,
    refresh: RefreshState,
    generation: number
  ): void {
    refresh.generation = generation;
    refresh.dirty = true;
    refresh.retries = 0;
    if (refresh.timer) {
      clearTimeout(refresh.timer);
      refresh.timer = undefined;
    }
    if (!refresh.running) this.scheduleRefresh(kiloSessionId, lifecycleGeneration, refresh);
  }

  private scheduleRefresh(
    kiloSessionId: string,
    lifecycleGeneration: number,
    refresh: RefreshState
  ): void {
    if (refresh.hasSlot) {
      this.startNextRefresh(kiloSessionId, lifecycleGeneration, refresh);
      return;
    }
    if (this.activeRefreshes >= MAX_CONCURRENT_SESSION_REFRESHES) {
      this.pendingRefreshes.add(kiloSessionId);
      return;
    }
    refresh.hasSlot = true;
    this.activeRefreshes += 1;
    this.startNextRefresh(kiloSessionId, lifecycleGeneration, refresh);
  }

  private startNextRefresh(
    kiloSessionId: string,
    lifecycleGeneration: number,
    refresh: RefreshState
  ): void {
    if (!this.isActive(lifecycleGeneration) || this.refreshes.get(kiloSessionId) !== refresh) {
      this.removeRefresh(kiloSessionId, refresh);
      return;
    }
    if (refresh.running || refresh.timer) return;
    refresh.running = true;
    refresh.dirty = false;
    const capturedGeneration = refresh.generation;
    void this.runRefresh(kiloSessionId, lifecycleGeneration, refresh, capturedGeneration);
  }

  private async runRefresh(
    kiloSessionId: string,
    lifecycleGeneration: number,
    refresh: RefreshState,
    capturedGeneration: number
  ): Promise<void> {
    let result;
    try {
      result = await this.env.SESSION_INGEST.getCloudAgentRootSessionSnapshot({
        kiloUserId: this.currentUserId,
        kiloSessionId,
      });
    } catch {
      if (!this.isRefreshCurrent(kiloSessionId, lifecycleGeneration, refresh, capturedGeneration)) {
        this.finishStaleRefresh(kiloSessionId, lifecycleGeneration, refresh, capturedGeneration);
        return;
      }
      this.scheduleSnapshotRetry(kiloSessionId, lifecycleGeneration, refresh, capturedGeneration);
      return;
    }

    if (!this.isRefreshCurrent(kiloSessionId, lifecycleGeneration, refresh, capturedGeneration)) {
      this.finishStaleRefresh(kiloSessionId, lifecycleGeneration, refresh, capturedGeneration);
      return;
    }
    if (!result) {
      this.finishCurrentRefresh(kiloSessionId, lifecycleGeneration, refresh);
      return;
    }
    if (result.snapshot.kind === 'pending' || result.snapshot.kind === 'retryable_failure') {
      this.scheduleSnapshotRetry(kiloSessionId, lifecycleGeneration, refresh, capturedGeneration);
      return;
    }
    if (result.snapshot.kind !== 'value') {
      this.finishCurrentRefresh(kiloSessionId, lifecycleGeneration, refresh);
      return;
    }

    const info = projectPublicSession(result.snapshot.info, kiloSessionId);
    const updated = info.time.updated;
    const fingerprint = JSON.stringify(info);
    const latest = this.versions.get(kiloSessionId);
    if (latest && updated < latest.updated) {
      this.finishCurrentRefresh(kiloSessionId, lifecycleGeneration, refresh);
      return;
    }
    if (
      latest &&
      updated === latest.updated &&
      (latest.fingerprint === fingerprint || latest.source === 'canonical')
    ) {
      this.finishCurrentRefresh(kiloSessionId, lifecycleGeneration, refresh);
      return;
    }
    this.rememberVersion(kiloSessionId, { updated, fingerprint, source: 'canonical' });
    this.broadcast(
      {
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload: {
          type: 'session.updated',
          properties: { sessionID: kiloSessionId, info },
        },
      },
      kiloSessionId
    );
    this.finishCurrentRefresh(kiloSessionId, lifecycleGeneration, refresh);
  }

  private scheduleSnapshotRetry(
    kiloSessionId: string,
    lifecycleGeneration: number,
    refresh: RefreshState,
    capturedGeneration: number
  ): void {
    if (refresh.retries >= 1) {
      this.finishCurrentRefresh(kiloSessionId, lifecycleGeneration, refresh);
      return;
    }
    refresh.retries += 1;
    refresh.running = false;
    refresh.timer = setTimeout(() => {
      refresh.timer = undefined;
      if (!this.isRefreshCurrent(kiloSessionId, lifecycleGeneration, refresh, capturedGeneration)) {
        this.finishStaleRefresh(kiloSessionId, lifecycleGeneration, refresh, capturedGeneration);
        return;
      }
      this.startNextRefresh(kiloSessionId, lifecycleGeneration, refresh);
    }, SNAPSHOT_RETRY_DELAY_MS);
  }

  private finishCurrentRefresh(
    kiloSessionId: string,
    lifecycleGeneration: number,
    refresh: RefreshState
  ): void {
    if (this.refreshes.get(kiloSessionId) !== refresh) return;
    refresh.running = false;
    if (refresh.dirty && this.isActive(lifecycleGeneration)) {
      this.startNextRefresh(kiloSessionId, lifecycleGeneration, refresh);
      return;
    }
    this.removeRefresh(kiloSessionId, refresh);
  }

  private finishStaleRefresh(
    kiloSessionId: string,
    lifecycleGeneration: number,
    refresh: RefreshState,
    capturedGeneration: number
  ): void {
    if (this.refreshes.get(kiloSessionId) !== refresh) return;
    refresh.running = false;
    if (
      this.isActive(lifecycleGeneration) &&
      (refresh.dirty || refresh.generation !== capturedGeneration)
    ) {
      this.startNextRefresh(kiloSessionId, lifecycleGeneration, refresh);
      return;
    }
    this.removeRefresh(kiloSessionId, refresh);
  }

  private removeRefresh(kiloSessionId: string, refresh: RefreshState): void {
    if (this.refreshes.get(kiloSessionId) !== refresh) return;
    this.refreshes.delete(kiloSessionId);
    this.pendingRefreshes.delete(kiloSessionId);
    if (refresh.hasSlot) {
      refresh.hasSlot = false;
      this.activeRefreshes -= 1;
    }
    this.pruneVersions();
    this.drainPendingRefreshes();
  }

  private drainPendingRefreshes(): void {
    while (
      this.activeRefreshes < MAX_CONCURRENT_SESSION_REFRESHES &&
      this.pendingRefreshes.size > 0
    ) {
      const kiloSessionId = this.pendingRefreshes.values().next().value;
      if (typeof kiloSessionId !== 'string') return;
      this.pendingRefreshes.delete(kiloSessionId);
      const refresh = this.refreshes.get(kiloSessionId);
      if (!refresh) continue;
      refresh.hasSlot = true;
      this.activeRefreshes += 1;
      this.startNextRefresh(kiloSessionId, this.lifecycleGeneration, refresh);
    }
  }

  private isRefreshCurrent(
    kiloSessionId: string,
    lifecycleGeneration: number,
    refresh: RefreshState,
    capturedGeneration: number
  ): boolean {
    return (
      this.isActive(lifecycleGeneration) &&
      this.refreshes.get(kiloSessionId) === refresh &&
      refresh.generation === capturedGeneration
    );
  }

  private isActive(generation: number): boolean {
    return generation > 0 && this.lifecycleGeneration === generation && this.isCurrent(generation);
  }

  private rememberVersion(kiloSessionId: string, version: SessionVersion): void {
    this.versions.delete(kiloSessionId);
    this.versions.set(kiloSessionId, version);
    this.pruneVersions();
  }

  private pruneVersions(): void {
    while (this.versions.size > MAX_TRACKED_SESSION_VERSIONS) {
      let candidate: string | undefined;
      for (const kiloSessionId of this.versions.keys()) {
        if (!this.refreshes.has(kiloSessionId)) {
          candidate = kiloSessionId;
          break;
        }
      }
      if (!candidate) return;
      this.versions.delete(candidate);
    }
  }
}
