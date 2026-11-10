import { createHash } from 'node:crypto';
import { isRecord, kiloEventSessionId } from '../../../src/shared/kilo-event.js';
import type { ControlPlaneTimers } from '../../../src/shared/control-plane-timers.js';
import type { KiloFeedEvent } from './kilo-event-feed.js';
import {
  activitySessionId,
  type ActivityPart,
  type ActivitySnapshotMessage,
  type HarnessActivityEvent,
} from './harness-activity.js';
import { kiloActivity } from './kilo-message-activity.js';
import {
  beginPause,
  endPause,
  pausedMs,
  restartPauses,
  type ExecutionPauses,
} from './execution-clock.js';

export type ExecutionFailure = 'no_progress' | 'execution_limit';
/** Kilo's last `retry` status since the execution's last real progress. */
export type ExecutionRetry = { message: string };
export type SessionActivity = 'running' | 'waiting' | 'stopping';
export type SessionInteraction = {
  id: string;
  blocking?: boolean;
  callID?: string;
};
export type SessionObservation = {
  id: string;
  directory: string;
  parentID?: string;
  status: 'busy' | 'retry' | 'idle';
  /** Present when `status` is `retry`. */
  retry?: ExecutionRetry;
  messages: ActivitySnapshotMessage[];
  interactions: SessionInteraction[];
};
export type ExecutionIdentity = {
  sessionId: string;
  directory: string;
  nativeRuntimeId: string;
  execution: number;
  ancestorSessionIds?: string[];
};
export type SessionSupervisorOptions = {
  nativeRuntimeId: string;
  directory: string;
  timers: Pick<ControlPlaneTimers['wrapper'], 'noProgressMs' | 'turnHardCapMs'>;
  now(): number;
  /** Resolves only after targeted cancellation is confirmed; runtime bounds its I/O. */
  interrupt(
    identity: ExecutionIdentity,
    reason: ExecutionFailure,
    signal: AbortSignal
  ): Promise<void>;
  /**
   * Called before native abort events can settle a Cloud message with another reason.
   * `retry` is set when a `no_progress` execution, or a descendant it stops, was stalled
   * in Kilo's model retry loop: the stall belongs to the model path, not the platform.
   * `stopped` confirms cancellation and native retirement, or resolves false on failure/disposal.
   */
  onDeadline(
    identity: ExecutionIdentity,
    reason: ExecutionFailure,
    retry: ExecutionRetry | undefined,
    stopped: Promise<boolean>
  ): void;
  /** The existing runtime owner performs bounded process recovery, including sibling failures. */
  onObservationFailure(reason: 'abort_unconfirmed' | 'activity_capacity'): void;
};

export function executionRetry(status: Record<string, unknown>): ExecutionRetry {
  return { message: typeof status.message === 'string' ? status.message : '' };
}

type Part = {
  kind: string;
  messageID: string;
  callID?: string;
  /** The tool waits for the user. */
  interactive: boolean;
  /** The session a subagent tool runs in. */
  childID?: string;
  status?: string;
  bytes: number;
  digest?: string;
};
type Execution = ExecutionPauses & {
  id: number;
  startedAt: number;
  lastProgressAt: number;
  progressed: boolean;
  status: 'busy' | 'retry' | 'idle';
  /** Kept through the `busy` status of each retry attempt; cleared by progress or `idle`. */
  retry?: ExecutionRetry;
  openRequests: number;
  activity: SessionActivity;
  parts: Map<string, Part>;
  interactions: Map<string, SessionInteraction>;
  /** Newest Kilo completion timestamp this execution already credited or retired. */
  evidenceThrough?: number;
  stop?: AbortController;
};
type Session = {
  id: string;
  directory: string;
  parentID?: string;
  revision: number;
  /** Live assistant messages only; completed terminal history is retired. */
  roles: Map<string, string>;
  execution?: Execution;
};

const MAX_SESSIONS = 1_000;
const MAX_EXECUTION_PARTS = 2_000;
const MAX_MESSAGE_ROLES = 1_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** One process lifetime owns these clocks. No Cloud route or message is needed. */
export function createSessionSupervisor(options: SessionSupervisorOptions) {
  const sessions = new Map<string, Session>();
  const tombstones = new Map<string, number>();
  let revision = 0;
  let executionId = 0;
  let snapshotSequence = 0;
  let snapshot: { id: number; revision: number } | undefined;
  let observed = true;
  let disposed = false;
  /** The runtime holds Kilo under memory pressure; no-progress clocks pause meanwhile. */
  let memoryHeld = false;

  function session(id: string, directory = options.directory): Session {
    const existing = sessions.get(id);
    if (existing) return existing;
    if (sessions.size >= MAX_SESSIONS) {
      options.onObservationFailure('activity_capacity');
      throw new Error('Session activity capacity exceeded');
    }
    // A native event stamps its own revision. A snapshot-only session has none, so
    // unrelated feed events during the read cannot fence it out of reconciliation.
    const next: Session = {
      id,
      directory,
      revision: -1,
      roles: new Map(),
    };
    sessions.set(id, next);
    return next;
  }

  function start(record: Session): Execution {
    return (record.execution ??= {
      id: ++executionId,
      startedAt: options.now(),
      lastProgressAt: options.now(),
      pausedMs: 0,
      ...(memoryHeld ? { heldSince: options.now() } : {}),
      progressed: false,
      status: 'busy',
      openRequests: 0,
      activity: 'running',
      parts: new Map(),
      interactions: new Map(),
    });
  }

  function identity(record: Session, execution: Execution): ExecutionIdentity {
    return {
      sessionId: record.id,
      directory: record.directory,
      nativeRuntimeId: options.nativeRuntimeId,
      execution: execution.id,
      ancestorSessionIds: ancestors(record).map(parent => parent.id),
    };
  }

  function finish(record: Session): void {
    record.execution = undefined;
    record.roles.clear();
    if (snapshot !== undefined) tombstones.set(record.id, revision);
  }

  function remember(record: Session, id: string, role: string): boolean {
    // User messages neither carry execution evidence nor need retention.
    if (role !== 'assistant') return true;
    if (record.roles.size >= MAX_MESSAGE_ROLES && !record.roles.has(id)) {
      options.onObservationFailure('activity_capacity');
      return false;
    }
    record.roles.set(id, role);
    return true;
  }

  /**
   * A completed assistant without a running or pending tool is terminal: its role and
   * parts cannot produce more progress, so retiring them keeps long serial generations
   * inside the role and part bounds. A completed message with a live tool is kept
   * whole, so a later re-read sees no change until that tool changes.
   */
  function retireMessage(record: Session, id: string): void {
    const parts = record.execution?.parts;
    const owned = parts ? [...parts].filter(([, part]) => part.messageID === id) : [];
    const pinned = owned.some(
      ([, part]) => part.kind === 'tool' && (part.status === 'running' || part.status === 'pending')
    );
    if (pinned) return;
    for (const [partId] of owned) parts?.delete(partId);
    record.roles.delete(id);
  }

  function creditCompleted(execution: Execution, completedAt: number): void {
    execution.evidenceThrough = Math.max(execution.evidenceThrough ?? completedAt, completedAt);
  }

  function prune(): void {
    const needed = new Set<string>();
    for (const record of sessions.values()) {
      if (!record.execution) continue;
      let next: Session | undefined = record;
      while (next && !needed.has(next.id)) {
        needed.add(next.id);
        next = next.parentID ? sessions.get(next.parentID) : undefined;
      }
    }
    for (const id of sessions.keys()) if (!needed.has(id)) sessions.delete(id);
  }

  function progress(record: Session): void {
    const visited = new Set<string>();
    let next: Session | undefined = record;
    while (next && !visited.has(next.id)) {
      visited.add(next.id);
      const execution = next.execution;
      if (execution && execution.activity !== 'stopping') {
        next.revision = revision;
        execution.lastProgressAt = options.now();
        execution.retry = undefined;
        restartPauses(execution, options.now());
        execution.progressed = true;
      }
      next = next.parentID ? sessions.get(next.parentID) : undefined;
    }
  }

  function activity(record: Session, visiting = new Set<string>()): SessionActivity {
    const execution = record.execution;
    if (!execution) return 'waiting';
    if (execution.activity === 'stopping') return 'stopping';
    if (visiting.has(record.id)) return 'running';
    visiting.add(record.id);
    let blockedTool = false;
    for (const part of execution.parts.values()) {
      if (part.kind !== 'tool' || (part.status !== 'running' && part.status !== 'pending'))
        continue;
      const interaction = [...execution.interactions.values()].some(
        request => request.callID === part.callID && part.callID !== undefined
      );
      if (interaction || part.interactive) {
        blockedTool = true;
        continue;
      }
      if (part.childID) {
        const child = sessions.get(part.childID);
        if (child?.execution && activity(child, new Set(visiting)) === 'waiting') {
          blockedTool = true;
          continue;
        }
      }
      return 'running';
    }
    const blockingRequest = [...execution.interactions.values()].some(
      request => request.blocking !== false
    );
    return blockedTool || blockingRequest ? 'waiting' : 'running';
  }

  function refresh(): void {
    for (const record of sessions.values()) {
      const execution = record.execution;
      if (!execution) continue;
      const next = activity(record);
      if (next === 'waiting') beginPause(execution, 'waitingSince', options.now());
      else endPause(execution, 'waitingSince', options.now());
      execution.activity = next;
    }
  }

  function descendsFrom(record: Session, ancestor: string): boolean {
    const visited = new Set<string>();
    let parentId = record.parentID;
    while (parentId && !visited.has(parentId)) {
      if (parentId === ancestor) return true;
      visited.add(parentId);
      parentId = sessions.get(parentId)?.parentID;
    }
    return false;
  }

  function ancestors(record: Session): Session[] {
    const result: Session[] = [];
    const visited = new Set([record.id]);
    let parent = record.parentID ? sessions.get(record.parentID) : undefined;
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      result.push(parent);
      parent = parent.parentID ? sessions.get(parent.parentID) : undefined;
    }
    return result;
  }

  function observePart(record: Session, part: ActivityPart): 'new' | 'changed' | 'unchanged' {
    if (record.roles.get(part.messageId) !== 'assistant') return 'unchanged';
    const tool = part.tool;
    // Historical terminal parts alone cannot create an execution.
    const execution = record.execution ?? (tool?.status === 'running' ? start(record) : undefined);
    if (!execution || execution.activity === 'stopping') return 'unchanged';
    const previous = execution.parts.get(part.id);
    const content = (tool ? tool.output : part.text) ?? '';
    const next: Part = {
      kind: part.kind,
      messageID: part.messageId,
      callID: tool?.callId,
      interactive: tool?.interactive === true,
      childID: tool?.childSessionId,
      status: tool?.status,
      bytes: Buffer.byteLength(content),
      digest: hash(content),
    };
    const changed =
      !previous ||
      next.status !== previous.status ||
      next.bytes !== previous.bytes ||
      (previous.digest !== undefined && next.digest !== previous.digest);
    if (!previous && execution.parts.size >= MAX_EXECUTION_PARTS) {
      options.onObservationFailure('activity_capacity');
      return 'unchanged';
    }
    execution.parts.set(part.id, next);
    if (!changed || (!previous && next.bytes === 0 && !tool)) return 'unchanged';
    return previous ? 'changed' : 'new';
  }

  function interaction(
    type: string,
    properties: Record<string, unknown>
  ): SessionInteraction | undefined {
    if (
      !['question.asked', 'permission.asked', 'suggestion.shown'].includes(type) ||
      typeof properties.id !== 'string'
    )
      return;
    const tool = isRecord(properties.tool) ? properties.tool : {};
    return {
      id: properties.id,
      blocking: properties.blocking !== false,
      callID: typeof tool.callID === 'string' ? tool.callID : undefined,
    };
  }

  function observe(event: KiloFeedEvent): void {
    if (disposed || event.nativeRuntimeId !== options.nativeRuntimeId) return;
    const activity = kiloActivity(event.type, event.properties);
    if (activity.length > 0) {
      for (const item of activity) observeActivity({ ...event, activity: item });
      return;
    }
    const id = kiloEventSessionId(event.properties);
    if (!id) return;
    const properties = event.properties;
    revision++;
    if (snapshot !== undefined) tombstones.set(id, revision);
    if (event.type === 'session.deleted') {
      const record = sessions.get(id);
      if (record) finish(record);
      return;
    }
    const record = session(id, event.directory);
    record.revision = revision;
    const info = isRecord(properties.info) ? properties.info : undefined;
    if (event.type === 'session.created' || event.type === 'session.updated') {
      if (typeof info?.parentID === 'string') record.parentID = info.parentID;
      if (typeof info?.directory === 'string') record.directory = info.directory;
    } else if (event.type === 'session.turn.open') {
      const previous = record.execution;
      if (
        previous?.activity === 'stopping' &&
        previous.status === 'idle' &&
        previous.openRequests === 0
      ) {
        finish(record);
      }
      start(record).openRequests++;
    } else if (event.type === 'session.status') {
      const statusObject = isRecord(properties.status) ? properties.status : {};
      const status = statusObject.type;
      if (status === 'busy' || status === 'retry') start(record).status = status;
      if (status === 'retry') start(record).retry = executionRetry(statusObject);
      if (status === 'idle' && record.execution) {
        record.execution.status = 'idle';
        record.execution.retry = undefined;
      }
    } else if (event.type === 'session.turn.close' && record.execution) {
      const execution = record.execution;
      execution.openRequests = Math.max(0, execution.openRequests - 1);
      // A `superseded` close is Kilo handing off to a queued follow-up: the next turn
      // continues this execution, so its no-progress and wall-clock limits keep running.
      // If no turn follows, the next idle snapshot finishes it.
      if (
        execution.openRequests === 0 &&
        execution.status === 'idle' &&
        execution.activity !== 'stopping' &&
        properties.reason !== 'superseded'
      ) {
        finish(record);
        prune();
      }
    } else {
      const request = interaction(event.type, properties);
      if (request) start(record).interactions.set(request.id, request);
      if (
        [
          'question.replied',
          'question.rejected',
          'permission.replied',
          'suggestion.accepted',
          'suggestion.dismissed',
        ].includes(event.type) &&
        typeof properties.requestID === 'string'
      ) {
        record.execution?.interactions.delete(properties.requestID);
      }
    }
    refresh();
  }

  /** CLI-neutral evidence of model work from the runtime's harness. */
  function observeActivity(event: HarnessActivityEvent): void {
    if (disposed || event.nativeRuntimeId !== options.nativeRuntimeId) return;
    const id = activitySessionId(event.activity);
    revision++;
    if (snapshot !== undefined) tombstones.set(id, revision);
    const record = session(id, event.directory);
    record.revision = revision;
    const activity = event.activity;
    if (activity.type === 'message') {
      const { message } = activity;
      if (message.role === 'assistant') {
        if (message.time?.completed !== undefined) {
          // Live parts were already observed for this role, so completion itself adds
          // no progress; it only fences out later replay of the same terminal history.
          const execution = record.execution;
          if (execution && record.roles.get(message.id) === 'assistant')
            creditCompleted(execution, message.time.completed);
          retireMessage(record, message.id);
        } else if (!remember(record, message.id, message.role)) {
          return;
        }
      }
    } else if (activity.type === 'part') {
      if (observePart(record, activity.part) !== 'unchanged') progress(record);
    } else if (record.roles.get(activity.messageId) === 'assistant' && activity.text.length > 0) {
      const part = start(record).parts.get(activity.partId);
      if (part) {
        part.bytes += Buffer.byteLength(activity.text);
        part.digest = undefined;
      }
      progress(record);
    }
    refresh();
  }

  function beginSnapshot(): number {
    if (snapshot !== undefined) throw new Error('Activity snapshot already in flight');
    snapshot = { id: ++snapshotSequence, revision };
    return snapshot.id;
  }

  function reconcile(observations: SessionObservation[], token: number): void {
    if (disposed || token !== snapshot?.id) return;
    const observedThrough = snapshot.revision;
    try {
      for (const item of observations) {
        if (
          // finish() tombstones at the current revision without advancing it.
          (tombstones.get(item.id) ?? -1) >= observedThrough ||
          (sessions.get(item.id)?.revision ?? -1) > observedThrough
        )
          continue;
        const record = session(item.id, item.directory);
        if (record.revision > observedThrough || record.execution?.activity === 'stopping')
          continue;
        record.parentID = item.parentID;
        const runningParts = item.messages
          .flatMap(m => m.parts)
          .some(part => part.tool?.status === 'running' || part.tool?.status === 'pending');
        if (item.status === 'idle' && !runningParts) {
          finish(record);
          continue;
        }
        const knownExecution = record.execution !== undefined;
        const execution = start(record);
        execution.status = item.status;
        execution.interactions = new Map(item.interactions.map(request => [request.id, request]));
        const partIds = new Set<string>();
        for (const message of item.messages) {
          const { id, role, time } = message;
          if (role !== 'assistant') continue;
          const completedAt = typeof time?.completed === 'number' ? time.completed : undefined;
          const live = record.roles.get(id) === 'assistant';
          const pinnedLive = message.parts.some(
            part => part.tool?.status === 'running' || part.tool?.status === 'pending'
          );
          if (completedAt !== undefined && !live && !pinnedLive) {
            // Terminal history is not replayed as progress. A completion newer than
            // this execution's retired frontier still proves work happened during a
            // feed gap, so credit that source timestamp exactly once.
            const recovered = message.parts.some(
              part =>
                part.kind === 'tool' ||
                ((part.kind === 'text' || part.kind === 'reasoning') &&
                  (part.text?.length ?? 0) > 0)
            );
            if (
              recovered &&
              knownExecution &&
              completedAt >= execution.startedAt &&
              completedAt > (execution.evidenceThrough ?? Number.NEGATIVE_INFINITY)
            ) {
              creditCompleted(execution, completedAt);
              progress(record);
            }
            retireMessage(record, id);
            continue;
          }
          if (!remember(record, id, role)) return;
          for (const part of message.parts) {
            partIds.add(part.id);
            const change = observePart(record, part);
            // Recovery may first discover execution after it already produced output
            // or started a tool. Latch that evidence for safe resubmission without
            // treating historical hydration as fresh clock progress.
            if (
              !knownExecution &&
              message.role === 'assistant' &&
              message.time?.completed === undefined &&
              change !== 'unchanged'
            ) {
              execution.progressed = true;
            }
            const newEvidence =
              change === 'new' &&
              knownExecution &&
              message.time !== undefined &&
              message.time.created >= execution.startedAt;
            if (change === 'changed' || newEvidence) progress(record);
          }
          if (completedAt !== undefined) {
            creditCompleted(execution, completedAt);
            retireMessage(record, id);
          }
        }
        // The adapter includes each known in-flight message, so missing parts have ended.
        for (const id of execution.parts.keys()) if (!partIds.has(id)) execution.parts.delete(id);
        // After the parts: a snapshot that is still retrying is retrying after any progress it shows.
        if (item.retry) execution.retry = item.retry;
        else if (item.status === 'idle') execution.retry = undefined;
      }
      observed = true;
      refresh();
    } finally {
      snapshot = undefined;
      tombstones.clear();
      prune();
    }
  }

  function tick(): void {
    if (disposed || !observed) return;
    refresh();
    for (const record of [...sessions.values()].sort(
      (a, b) => ancestors(a).length - ancestors(b).length
    )) {
      const execution = record.execution;
      if (!execution || execution.activity === 'stopping') continue;
      if (ancestors(record).some(parent => parent.execution?.activity === 'stopping')) continue;
      const paused = pausedMs(execution, options.now());
      const reason =
        options.now() - execution.startedAt >= options.timers.turnHardCapMs
          ? 'execution_limit'
          : execution.activity !== 'waiting' &&
              options.now() - execution.lastProgressAt - paused >= options.timers.noProgressMs
            ? 'no_progress'
            : undefined;
      if (!reason) continue;
      const stop = new AbortController();
      execution.stop = stop;
      execution.activity = 'stopping';
      const target = identity(record, execution);
      const stoppedChildren = [...sessions.values()].flatMap(child =>
        child.execution && descendsFrom(child, record.id)
          ? [{ record: child, execution: child.execution }]
          : []
      );
      // Parents expire first, so a subagent stalled in a retry loop is found among
      // the descendants this deadline stops.
      const retry =
        reason === 'no_progress'
          ? [execution, ...stoppedChildren.map(child => child.execution)].find(item => item.retry)
              ?.retry
          : undefined;
      const stopped = Promise.withResolvers<boolean>();
      const cancelled = () => stopped.resolve(false);
      stop.signal.addEventListener('abort', cancelled, { once: true });
      options.onDeadline(target, reason, retry, stopped.promise);
      void options.interrupt(target, reason, stop.signal).then(
        () => {
          stop.signal.removeEventListener('abort', cancelled);
          if (disposed || stop.signal.aborted) {
            stopped.resolve(false);
            return;
          }
          if (record.execution === execution) finish(record);
          for (const child of stoppedChildren) {
            if (child.record.execution === child.execution) finish(child.record);
          }
          prune();
          stopped.resolve(true);
        },
        () => {
          stop.signal.removeEventListener('abort', cancelled);
          stopped.resolve(false);
          if (!disposed && record.execution === execution)
            options.onObservationFailure('abort_unconfirmed');
        }
      );
    }
  }

  return {
    observe,
    observeActivity,
    beginSnapshot,
    reconcile,
    tick,
    observationLost() {
      observed = false;
    },
    holdMemory(held: boolean) {
      memoryHeld = held;
      for (const record of sessions.values()) {
        if (!record.execution) continue;
        if (held) beginPause(record.execution, 'heldSince', options.now());
        else endPause(record.execution, 'heldSince', options.now());
      }
    },
    snapshotFailed(token: number) {
      if (token !== snapshot?.id) return;
      snapshot = undefined;
      tombstones.clear();
      observed = false;
    },
    needsCompute: () =>
      [...sessions.values()].some(
        record => record.execution && record.execution.activity !== 'waiting'
      ),
    hasRecentProgress: (withinMs: number) =>
      [...sessions.values()].some(
        record =>
          record.execution &&
          record.execution.activity !== 'stopping' &&
          record.execution.progressed &&
          options.now() - record.execution.lastProgressAt < withinMs
      ),
    state(id: string) {
      const record = sessions.get(id);
      const execution = record?.execution;
      return record && execution
        ? {
            ...identity(record, execution),
            activity: execution.activity,
            progressed: execution.progressed,
            startedAt: execution.startedAt,
          }
        : undefined;
    },
    observedSessions: () =>
      [...sessions.values()].flatMap(record =>
        record.execution
          ? [
              {
                id: record.id,
                directory: record.directory,
                // Only live messages: completed history is retired rather than re-read,
                // so a long serial execution's snapshot does not grow with its steps.
                messageIds: [
                  ...new Set([
                    ...[...record.execution.parts.values()].map(part => part.messageID),
                    ...[...record.roles].flatMap(([id, role]) =>
                      role === 'assistant' ? [id] : []
                    ),
                  ]),
                ],
              },
            ]
          : []
      ),
    dispose() {
      disposed = true;
      for (const record of sessions.values()) record.execution?.stop?.abort();
      sessions.clear();
      tombstones.clear();
    },
  };
}

export type SessionSupervisor = ReturnType<typeof createSessionSupervisor>;
