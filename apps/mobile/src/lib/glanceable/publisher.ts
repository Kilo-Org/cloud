import {
  buildGlanceableSnapshot,
  GLANCEABLE_COALESCE_MS,
  GLANCEABLE_STALE_MS,
  GLANCEABLE_TERMINAL_MS,
  type GlanceableAgentsSnapshot,
  isEligibleGlanceableWork,
  isStartableGlanceableWork,
  shouldDiscardGlanceableRevision,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { type NewestSessionRow, newestSessionTitle } from './newest-session';
import { hasSameGlanceableContent, withStatus } from './snapshot-transforms';
import {
  getGlanceableDelivery,
  type GlanceableSink,
  type GlanceableSinkContext,
  guardSink,
} from './sink-registry';
import { getSurfaceExtras, setSurfaceExtras } from './surface-extras';
import { selectWaitingAsk, type WaitingAsk, type WaitingAskRow } from './waiting-ask';

export { hasSameGlanceableContent, withStatus };

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
  /**
   * Confirmed-lost-org latch reader (see cleanup). Read on every emit, not at
   * construction, so a publisher rebuilt by a token refresh or a remount stays
   * silent until a successful org list confirms membership again.
   */
  orgLost?: () => boolean;
  /**
   * The one waiting ask the activity's action buttons can name, or null when
   * nothing waits (see `selectWaitingAsk`). Data in, data out: the publisher
   * never touches the store itself, so the headless wiring and the app wiring
   * cannot drift. Absent when no surface can action an ask.
   */
  onWaitingAskChange?: (ask: WaitingAsk | null) => void;
  /**
   * A session the ask selection must skip, while its row still counts in the
   * snapshot. The post-answer refresh passes the session it just answered, once
   * the action that answered it ended the ask: its tray row can still read
   * permission/question while the control plane's status sync lands and it is
   * usually the oldest asking row, so selecting it would re-offer the action
   * the user already took and leave a second waiting session unrecorded.
   * Skipping it at selection, not by dropping the row, keeps the counts coming
   * from the tray. Absent while the ask still waits: its row is then the truth,
   * and the retry has to answer that same session.
   */
  skipWaitingAskSessionId?: string;
};

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Renew the published deadline once the surface is within this margin of its
 * stale frame (`updatedAt + GLANCEABLE_STALE_MS`). The tray heartbeats every
 * 10–30 s, so renewing at half the window leaves the heartbeat free to rewrite
 * the native surface only once per half window, not once per heartbeat, while
 * still refreshing well before the widget stale frame and the Live Activity
 * stale date land.
 */
export const GLANCEABLE_RENEW_MARGIN_MS = GLANCEABLE_STALE_MS / 2;

export class GlanceablePublisher {
  private readonly sinks: readonly GlanceableSink[];
  private readonly now: () => number;
  private readonly coalesceMs: number;
  private readonly terminalMs: number;
  private readonly terminalBlankEpoch: () => number;
  private readonly blankEpochAtStart: number;
  private readonly orgLost: () => boolean;
  private readonly onWaitingAskChange?: (ask: WaitingAsk | null) => void;
  private readonly skipWaitingAskSessionId?: string;
  private current: GlanceableAgentsSnapshot | null;
  private activityStarted: boolean;
  /**
   * `updatedAt` of the snapshot last written to a sink, i.e. the frame the
   * native stale deadline keys off. A heartbeat whose visible content did not
   * change leaves it alone, so the renewal gate can tell how close that
   * deadline is.
   */
  private lastPublishedAt: number | null = null;
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
    this.orgLost = options.orgLost ?? (() => false);
    this.onWaitingAskChange = options.onWaitingAskChange;
    this.skipWaitingAskSessionId = options.skipWaitingAskSessionId;
    this.current = options.initial ?? null;
    this.activityStarted = false;
  }

  /**
   * Cache success: derive the next snapshot from the current session rows. The
   * rows carry both the newest-session fields the Home Screen widgets read and
   * the session id the activity's action buttons need.
   */
  handleSessions(
    sessions: readonly (NewestSessionRow & WaitingAskRow)[],
    ctx: GlanceablePublisherContext
  ): void {
    if (this.isGated()) {
      // Nothing is asking while the publisher is gated: a terminal blank must
      // not leave an approvable ask behind for the action buttons.
      this.noteWaitingAsk(null);
      return;
    }
    // The newest session's title never enters the snapshot (privacy contract):
    // it rides in the surface extras every widget reads on redraw.
    const previousTitle = getSurfaceExtras().newestSessionTitle;
    const nextTitle = newestSessionTitle(sessions);
    setSurfaceExtras({ ...getSurfaceExtras(), newestSessionTitle: nextTitle });
    getGlanceableDelivery().registerScopeTokens(ctx.organizationId, ctx.userId);
    const now = this.now();
    this.applyExpiry(now, ctx);

    const snapshot = buildGlanceableSnapshot({
      sessions,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      now,
      previousRevision: this.current?.revision ?? 0,
    });

    // The rows are the only place the session id exists, so the ask is selected
    // here, on every heartbeat, before the unchanged-content gate below: that
    // gate is about the native surface, and the ask is not part of it. The
    // visible content can stay identical — the same counts and wait anchor —
    // while the session that waits changes, because neither the session id nor
    // the tray order is a snapshot field: a tie on `statusUpdatedAt` resolves to
    // the first asking row, and an answered row leaving while another starts
    // keeps the counts. Selecting before the gate, not after it, is what keeps
    // the Approve/Open target on the row that is actually asking.
    this.noteWaitingAsk(
      isEligibleGlanceableWork(snapshot) ? selectWaitingAsk(this.askRows(sessions), ctx, now) : null
    );

    // Every heartbeat writes the tray cache, so a write whose visible content
    // did not change must not re-render the widget or update the ongoing
    // notification / Live Activity. It must still renew the deadline before it
    // lapses, because `updatedAt`/`expiresAt`, the widget stale frame, and the
    // Live Activity stale date all key off the published write: skipping the
    // renewal would falsely flag confirmed-current data as stale, while
    // publishing every heartbeat would rewrite the native surface every few
    // seconds. So renew only once the published frame approaches its stale
    // window, and renew through `emit` rather than `publish`: the start/update
    // call is what retries a Live Activity start the sink could not raise (a
    // transient ActivityKit failure, or a start deferred behind a dismissal),
    // and leaving it out of the renewal would strand that surface until the
    // counts next changed. Keep the revision monotonic for the next real emit,
    // and leave any pending coalesced emit alone. The first eligible emit
    // (nothing started yet) is exempt: it is what raises the surface.
    if (
      this.current !== null &&
      hasSameGlanceableContent(
        { snapshot: this.current, newestSessionTitle: previousTitle },
        { snapshot, newestSessionTitle: nextTitle }
      ) &&
      (this.activityStarted || !isEligibleGlanceableWork(snapshot))
    ) {
      if (
        isEligibleGlanceableWork(snapshot) &&
        (this.lastPublishedAt === null || now - this.lastPublishedAt >= GLANCEABLE_RENEW_MARGIN_MS)
      ) {
        // The renewal frame carries the same visible content as any pending
        // coalesced emit but a newer revision, so emitting it supersedes that
        // timer: leaving the timer armed would republish the older frame after
        // this one and move `lastPublishedAt` backwards, marking the surface
        // stale again right after it was renewed.
        this.cancelCoalesce();
        this.emit(snapshot, ctx);
      }
      this.current = snapshot;
      return;
    }

    // `needsApproval` is optional, so normalize it for the coalesce decision.
    const previousNeedsApproval = this.current?.needsApproval ?? 0;

    if (isEligibleGlanceableWork(snapshot)) {
      this.cancelTerminal();
      if (!this.activityStarted) {
        // First eligible emit starts the activity immediately, no coalesce wait.
        this.emit(snapshot, ctx);
        this.activityStarted = true;
      } else if (
        snapshot.needsInput !== this.current?.needsInput ||
        (snapshot.needsApproval ?? 0) !== previousNeedsApproval
      ) {
        // Actionable needs-input/approval changes must reach the launcher
        // immediately: `needsApproval` gates the Approve control on every
        // surface, and a question <-> permission move keeps `needsInput`
        // constant while that control appears or disappears.
        this.cancelCoalesce();
        this.emit(snapshot, ctx);
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
    getGlanceableDelivery().registerScopeTokens(ctx.organizationId, ctx.userId);
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

  /** Cache update failed: keep the last counts only until their original deadline. */
  handleFetchError(ctx: GlanceablePublisherContext): void {
    // A failed refetch supersedes the ask: the surface now shows stale counts,
    // so a still-recorded waiting session must not stay approvable from it.
    this.noteWaitingAsk(null);
    if (this.isGated() || this.current === null) {
      return;
    }
    // A fetch error supersedes any pending coalesced happy emit: otherwise the
    // pre-error snapshot would fire later and overwrite the stale counts.
    this.cancelCoalesce();
    const snapshot = withStatus(this.current, 'stale', this.now());
    if (snapshot === this.current) {
      return;
    }
    if (snapshot.status === 'expired') {
      this.cancelTerminal();
      this.activityStarted = false;
    }
    if (isStartableGlanceableWork(snapshot)) {
      // A failed refresh must never empty the shade. `publish` only updates a
      // card that is already posted, so a restart that could not reach the
      // server (the post is gone with the process) would leave the shade blank
      // even though the durable mirror still holds waiting or running work.
      // `emit` re-posts it from the last known counts, without an alert.
      this.emit(snapshot, ctx);
      this.activityStarted = true;
    } else {
      this.publish(snapshot);
    }
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
    if (incoming.status !== 'signed_out' && incoming.status !== 'privacy') {
      getGlanceableDelivery().registerScopeTokens(ctx.organizationId, ctx.userId);
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
    return this.terminalBlankEpoch() !== this.blankEpochAtStart || this.orgLost();
  }

  /** Hand the current ask to the consumer, when one is wired. */
  private noteWaitingAsk(ask: WaitingAsk | null): void {
    this.onWaitingAskChange?.(ask);
  }

  /**
   * The rows the ask selection may name: every row except the session whose ask
   * was already actioned. That row still counts in the snapshot.
   */
  private askRows(
    sessions: readonly (NewestSessionRow & WaitingAskRow)[]
  ): readonly (NewestSessionRow & WaitingAskRow)[] {
    const skip = this.skipWaitingAskSessionId;
    return skip === undefined ? sessions : sessions.filter(row => row.id !== skip);
  }

  private emit(snapshot: GlanceableAgentsSnapshot, ctx: GlanceableSinkContext): void {
    this.lastPublishedAt = Date.parse(snapshot.updatedAt);
    for (const sink of this.sinks) {
      // Guarded separately: a failing widget timeline write must not skip the
      // Live Activity start that follows it.
      guardSink('emit_publish', () => {
        sink.publish(snapshot);
      });
      guardSink('emit_start_or_update', () => {
        sink.startOrUpdate(snapshot, ctx);
      });
    }
  }

  private publish(snapshot: GlanceableAgentsSnapshot): void {
    this.lastPublishedAt = Date.parse(snapshot.updatedAt);
    for (const sink of this.sinks) {
      guardSink('publish', () => {
        sink.publish(snapshot);
      });
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
        guardSink('terminal_end', () => {
          if (!sink.waitForNativeTerminal) {
            sink.endImmediate();
          }
        });
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
