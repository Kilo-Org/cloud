import {
  buildGlanceableSnapshot,
  GLANCEABLE_COALESCE_MS,
  GLANCEABLE_SNAPSHOT_EXPIRY_MS,
  GLANCEABLE_TERMINAL_MS,
  type GlanceableAgentsSnapshot,
  type GlanceableAgentsSnapshotStatus,
  isEligibleGlanceableWork,
  shouldDiscardGlanceableRevision,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { type GlanceableSink, type GlanceableSinkContext } from './sink-registry';

/**
 * Framework-agnostic publisher state machine. Derives one versioned snapshot
 * from the active-sessions tray cache, coalesces later happy updates, starts
 * the activity on the first eligible emit, and schedules the 8 s terminal end
 * when work becomes empty. The React glue is `mount.tsx`.
 */

export type GlanceablePublisherContext = {
  userId: string;
  organizationId: string | null;
};

export type GlanceablePublisherOptions = {
  sinks: readonly GlanceableSink[];
  /** Seeded from the persisted last snapshot so revision stays monotonic. */
  initial?: GlanceableAgentsSnapshot | null;
  now?: () => number;
  coalesceMs?: number;
  terminalMs?: number;
  /**
   * Monotonic terminal-blank epoch reader (see cleanup). The publisher captures
   * it at construction and refuses to emit once it advances, so a live cache
   * success after a signed-out or privacy blank cannot republish or restart.
   */
  terminalBlankEpoch?: () => number;
};

type TimerHandle = ReturnType<typeof setTimeout>;

/** Copy a snapshot with a new status and a fresh revision/updatedAt/expiresAt. */
export function withStatus(
  snapshot: GlanceableAgentsSnapshot,
  status: GlanceableAgentsSnapshotStatus,
  now: number
): GlanceableAgentsSnapshot {
  const updatedAt = new Date(now).toISOString();
  return {
    ...snapshot,
    revision: snapshot.revision + 1,
    updatedAt,
    expiresAt: new Date(now + GLANCEABLE_SNAPSHOT_EXPIRY_MS).toISOString(),
    status,
  };
}

export class GlanceablePublisher {
  private readonly sinks: readonly GlanceableSink[];
  private readonly now: () => number;
  private readonly coalesceMs: number;
  private readonly terminalMs: number;
  private readonly terminalBlankEpoch: () => number;
  private readonly blankEpochAtStart: number;
  private current: GlanceableAgentsSnapshot | null;
  private activityStarted: boolean;
  private coalesceTimer: TimerHandle | null = null;
  private terminalTimer: TimerHandle | null = null;
  private pendingCoalesced: {
    snapshot: GlanceableAgentsSnapshot;
    ctx: GlanceableSinkContext;
  } | null = null;

  constructor(options: GlanceablePublisherOptions) {
    this.sinks = options.sinks;
    this.now = options.now ?? (() => Date.now());
    this.coalesceMs = options.coalesceMs ?? GLANCEABLE_COALESCE_MS;
    this.terminalMs = options.terminalMs ?? GLANCEABLE_TERMINAL_MS;
    this.terminalBlankEpoch = options.terminalBlankEpoch ?? (() => 0);
    this.blankEpochAtStart = this.terminalBlankEpoch();
    this.current = options.initial ?? null;
    this.activityStarted = false;
  }

  /** Cache success: derive the next snapshot from the current session rows. */
  handleSessions(sessions: readonly { status: string }[], ctx: GlanceablePublisherContext): void {
    if (this.isGated()) {
      return;
    }
    const now = this.now();
    this.applyExpiry(now, ctx);

    const snapshot = buildGlanceableSnapshot({
      sessions,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      now,
      previousRevision: this.current?.revision ?? 0,
      previousEligibleStartedAt: this.current?.eligibleStartedAt ?? null,
    });

    if (isEligibleGlanceableWork(snapshot)) {
      this.cancelTerminal();
      if (!this.activityStarted) {
        // First eligible emit starts the activity immediately, no coalesce wait.
        this.emit(snapshot, ctx);
        this.activityStarted = true;
      } else {
        this.scheduleCoalesced(snapshot, ctx);
      }
    } else {
      this.cancelCoalesce();
      this.publish(snapshot);
      if (this.activityStarted) {
        // Happy → empty: terminal end after the brief empty window.
        this.scheduleTerminal();
      }
      this.activityStarted = false;
    }
    this.current = snapshot;
  }

  /** First fetch in flight with no snapshot yet: waiting, never started. */
  handleFetchStarted(ctx: GlanceablePublisherContext): void {
    if (this.isGated()) {
      return;
    }
    if (this.current !== null) {
      return;
    }
    const snapshot = buildGlanceableSnapshot({
      sessions: [],
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      now: this.now(),
      status: 'waiting',
    });
    this.publish(snapshot);
    this.current = snapshot;
  }

  /** Cache update failed: republish the last counts with a stale status. */
  handleFetchError(ctx: GlanceablePublisherContext): void {
    if (this.isGated()) {
      return;
    }
    const now = this.now();
    if (this.applyExpiry(now, ctx) || this.current === null) {
      return;
    }
    // A fetch error supersedes any pending coalesced happy emit: otherwise the
    // pre-error snapshot would fire later and overwrite the stale counts.
    this.cancelCoalesce();
    const snapshot = withStatus(this.current, 'stale', now);
    this.publish(snapshot);
    this.current = snapshot;
  }

  /**
   * Apply an incoming snapshot (future background delivery). Older revisions
   * are discarded; the local account epoch is applied by the caller.
   */
  applySnapshot(incoming: GlanceableAgentsSnapshot, ctx: GlanceablePublisherContext): void {
    if (this.isGated()) {
      return;
    }
    if (this.current !== null && shouldDiscardGlanceableRevision(incoming, this.current)) {
      return;
    }
    // A late background delivery supersedes a pending coalesced emit and any
    // pending 8 s terminal, so neither can fire after the newer snapshot.
    this.cancelCoalesce();
    this.cancelTerminal();
    if (isEligibleGlanceableWork(incoming)) {
      this.emit(incoming, ctx);
      this.activityStarted = true;
    } else {
      this.publish(incoming);
      this.activityStarted = false;
    }
    this.current = incoming;
  }

  dispose(): void {
    this.cancelCoalesce();
    this.cancelTerminal();
  }

  private isGated(): boolean {
    return this.terminalBlankEpoch() !== this.blankEpochAtStart;
  }

  private emit(snapshot: GlanceableAgentsSnapshot, ctx: GlanceableSinkContext): void {
    for (const sink of this.sinks) {
      sink.publish(snapshot);
      sink.startOrUpdate(snapshot, ctx);
    }
  }

  private publish(snapshot: GlanceableAgentsSnapshot): void {
    for (const sink of this.sinks) {
      sink.publish(snapshot);
    }
  }

  private scheduleCoalesced(snapshot: GlanceableAgentsSnapshot, ctx: GlanceableSinkContext): void {
    this.pendingCoalesced = { snapshot, ctx };
    if (this.coalesceTimer !== null) {
      return;
    }
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      const pending = this.pendingCoalesced;
      this.pendingCoalesced = null;
      if (pending !== null && !this.isGated()) {
        this.emit(pending.snapshot, pending.ctx);
      }
    }, this.coalesceMs);
  }

  private scheduleTerminal(): void {
    if (this.terminalTimer !== null) {
      return;
    }
    this.terminalTimer = setTimeout(() => {
      this.terminalTimer = null;
      this.activityStarted = false;
      for (const sink of this.sinks) {
        sink.endImmediate();
      }
    }, this.terminalMs);
  }

  private cancelCoalesce(): void {
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    this.pendingCoalesced = null;
  }

  private cancelTerminal(): void {
    if (this.terminalTimer !== null) {
      clearTimeout(this.terminalTimer);
      this.terminalTimer = null;
    }
  }

  /** Publish an expired snapshot (zero counts) once the current one lapses. */
  private applyExpiry(now: number, ctx: GlanceablePublisherContext): boolean {
    if (this.current === null || now < Date.parse(this.current.expiresAt)) {
      return false;
    }
    const snapshot = buildGlanceableSnapshot({
      sessions: [],
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      now,
      previousRevision: this.current.revision,
      status: 'expired',
    });
    this.cancelCoalesce();
    this.cancelTerminal();
    this.publish(snapshot);
    this.current = snapshot;
    this.activityStarted = false;
    return true;
  }
}
