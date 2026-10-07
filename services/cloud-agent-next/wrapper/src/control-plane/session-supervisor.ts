import { createHash } from 'node:crypto';
import { isRecord, kiloEventSessionId } from '../../../src/shared/kilo-event.js';
import type { ControlPlaneTimers } from '../../../src/shared/control-plane-timers.js';
import type { KiloFeedEvent } from './kilo-event-feed.js';

export type ExecutionFailure = 'no_progress' | 'execution_limit';
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
  messages: Array<{
    info: { id: string; role: string; time?: { created: number; completed?: number } };
    parts: unknown[];
  }>;
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
  /** Called before native abort events can settle a Cloud message with another reason. */
  onDeadline(identity: ExecutionIdentity, reason: ExecutionFailure): void;
  /** The existing runtime owner performs bounded process recovery, including sibling failures. */
  onObservationFailure(reason: 'abort_unconfirmed' | 'activity_capacity'): void;
};

type Part = {
  kind: string;
  messageID: string;
  callID?: string;
  tool?: string;
  childID?: string;
  status?: string;
  bytes: number;
  digest?: string;
};
type Execution = {
  id: number;
  startedAt: number;
  lastProgressAt: number;
  pausedMs: number;
  waitingSince?: number;
  progressed: boolean;
  status: 'busy' | 'retry' | 'idle';
  openRequests: number;
  activity: SessionActivity;
  parts: Map<string, Part>;
  interactions: Map<string, SessionInteraction>;
  stop?: AbortController;
};
type Session = {
  id: string;
  directory: string;
  parentID?: string;
  revision: number;
  roles: Map<string, string>;
  /** Assistant messages Kilo reported complete; snapshots need not re-read them. */
  completed: Set<string>;
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
      completed: new Set(),
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
    record.completed.clear();
    if (snapshot !== undefined) tombstones.set(record.id, revision);
  }

  function remember(record: Session, id: string, role: string, completed: boolean): boolean {
    if (record.roles.size >= MAX_MESSAGE_ROLES && !record.roles.has(id)) {
      options.onObservationFailure('activity_capacity');
      return false;
    }
    record.roles.set(id, role);
    if (completed) record.completed.add(id);
    return true;
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
        execution.pausedMs = 0;
        if (execution.waitingSince !== undefined) execution.waitingSince = options.now();
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
      if (interaction || part.tool === 'question' || part.tool === 'suggest') {
        blockedTool = true;
        continue;
      }
      if (part.tool === 'task' && part.childID) {
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
      if (next === 'waiting' && execution.waitingSince === undefined)
        execution.waitingSince = options.now();
      if (next !== 'waiting' && execution.waitingSince !== undefined) {
        execution.pausedMs += Math.max(0, options.now() - execution.waitingSince);
        execution.waitingSince = undefined;
      }
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

  function observePart(record: Session, raw: unknown): 'new' | 'changed' | 'unchanged' {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.messageID !== 'string')
      return 'unchanged';
    if (record.roles.get(raw.messageID) !== 'assistant') return 'unchanged';
    const state = isRecord(raw.state) ? raw.state : {};
    const type = raw.type;
    if (type !== 'tool' && type !== 'text' && type !== 'reasoning') return 'unchanged';
    // Historical terminal parts alone cannot create an execution.
    const execution =
      record.execution ??
      (type === 'tool' && state.status === 'running' ? start(record) : undefined);
    if (!execution || execution.activity === 'stopping') return 'unchanged';
    const previous = execution.parts.get(raw.id);
    const metadata = isRecord(state.metadata) ? state.metadata : {};
    const output = type === 'tool' ? (state.output ?? metadata.output) : raw.text;
    const content = typeof output === 'string' ? output : '';
    const next: Part = {
      kind: type,
      messageID: raw.messageID,
      callID: typeof raw.callID === 'string' ? raw.callID : undefined,
      tool: typeof raw.tool === 'string' ? raw.tool : undefined,
      childID: typeof metadata.sessionId === 'string' ? metadata.sessionId : undefined,
      status: typeof state.status === 'string' ? state.status : undefined,
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
    execution.parts.set(raw.id, next);
    if (!changed || (!previous && next.bytes === 0 && type !== 'tool')) return 'unchanged';
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
      const status = isRecord(properties.status) ? properties.status.type : undefined;
      if (status === 'busy' || status === 'retry') start(record).status = status;
      if (status === 'idle' && record.execution) record.execution.status = 'idle';
    } else if (
      event.type === 'message.updated' &&
      typeof info?.id === 'string' &&
      typeof info.role === 'string'
    ) {
      const time = isRecord(info.time) ? info.time : {};
      if (!remember(record, info.id, info.role, time.completed !== undefined)) return;
    } else if (event.type === 'message.part.updated') {
      if (observePart(record, properties.part) !== 'unchanged') progress(record);
    } else if (
      event.type === 'message.part.delta' &&
      typeof properties.messageID === 'string' &&
      record.roles.get(properties.messageID) === 'assistant' &&
      typeof properties.delta === 'string' &&
      properties.delta.length > 0 &&
      (properties.field === 'text' || properties.field === undefined)
    ) {
      const execution = start(record);
      const part =
        typeof properties.partID === 'string' ? execution.parts.get(properties.partID) : undefined;
      if (part) {
        part.bytes += Buffer.byteLength(properties.delta);
        part.digest = undefined;
      }
      progress(record);
    } else if (event.type === 'session.turn.close' && record.execution) {
      const execution = record.execution;
      execution.openRequests = Math.max(0, execution.openRequests - 1);
      if (
        execution.openRequests === 0 &&
        execution.status === 'idle' &&
        execution.activity !== 'stopping'
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
          .some(
            part =>
              isRecord(part) &&
              part.type === 'tool' &&
              isRecord(part.state) &&
              ['running', 'pending'].includes(String(part.state.status))
          );
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
          const { id, role, time } = message.info;
          if (!remember(record, id, role, time?.completed !== undefined)) return;
          for (const part of message.parts) {
            if (isRecord(part) && typeof part.id === 'string') partIds.add(part.id);
            const change = observePart(record, part);
            // Recovery may first discover execution after it already produced output
            // or started a tool. Latch that evidence for safe resubmission without
            // treating historical hydration as fresh clock progress.
            if (
              !knownExecution &&
              message.info.role === 'assistant' &&
              message.info.time?.completed === undefined &&
              change !== 'unchanged'
            ) {
              execution.progressed = true;
            }
            const newEvidence =
              change === 'new' &&
              knownExecution &&
              message.info.time !== undefined &&
              message.info.time.created >= execution.startedAt;
            if (change === 'changed' || newEvidence) progress(record);
          }
        }
        // The adapter includes each known in-flight message, so missing parts have ended.
        for (const id of execution.parts.keys()) if (!partIds.has(id)) execution.parts.delete(id);
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
      const paused =
        execution.pausedMs +
        (execution.waitingSince === undefined ? 0 : options.now() - execution.waitingSince);
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
      options.onDeadline(target, reason);
      void options.interrupt(target, reason, stop.signal).then(
        () => {
          if (disposed) return;
          if (record.execution === execution) finish(record);
          for (const child of stoppedChildren) {
            if (child.record.execution === child.execution) finish(child.record);
          }
          prune();
        },
        () => {
          if (!disposed && record.execution === execution)
            options.onObservationFailure('abort_unconfirmed');
        }
      );
    }
  }

  return {
    observe,
    beginSnapshot,
    reconcile,
    tick,
    observationLost() {
      observed = false;
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
                // Only in-flight messages: re-reading completed history makes every
                // snapshot slower as a long execution accumulates steps.
                messageIds: [
                  ...new Set([
                    ...[...record.execution.parts.values()].map(part => part.messageID),
                    ...[...record.roles].flatMap(([id, role]) =>
                      role === 'assistant' ? [id] : []
                    ),
                  ]),
                ].filter(id => !record.completed.has(id)),
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
