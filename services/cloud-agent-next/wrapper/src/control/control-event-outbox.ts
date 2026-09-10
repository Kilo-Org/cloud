import { canonicalControlEventJson } from '../../../src/shared/control-event-canonical.js';
import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  sessionEventIdentitySchema,
} from '../../../src/shared/sandbox-control-protocol.js';
import type { SessionEventIdentity } from '../../../src/shared/sandbox-control-protocol.js';

const MAX_CONTROL_EVENT_OUTBOX_EVENTS = 256;
export const MAX_CONTROL_EVENT_OUTBOX_BYTES = 4 * MAX_SANDBOX_CONTROL_FRAME_BYTES;
const PUBLICATION_DEADLINE_MS = 30_000;

export type ControlEventPublication = {
  event: 'session.event' | 'session.preparing';
  receiptId: string;
  sequence: number;
  session: SessionEventIdentity;
  payload: unknown;
};

export type PreparedControlEventPublication = ControlEventPublication & {
  bytes: number;
  readonly deadlineAt: number;
  readonly preparedAt?: number;
};

export type ControlEventPublicationFailureReason =
  | 'expired'
  | 'rejected'
  | 'queue_overflow'
  | 'socket_overflow'
  | 'disconnected'
  | 'send_failed';

export type ControlEventOutboxFailure = {
  reason: ControlEventPublicationFailureReason;
  publication: ControlEventPublication;
  sent?: boolean;
  queueAgeMs?: number;
  attempts?: number;
  pendingCount?: number;
  pendingBytes?: number;
  requestId?: string;
  connectionState?: string;
  connectionId?: string;
  preparedAt?: number;
  socketBufferedBytes?: number;
  detail?: string;
};

export type ControlEventOutboxStats = {
  pendingCount: number;
  pendingBytes: number;
};

export type ControlEventOutbox = {
  prepare(
    input: Omit<ControlEventPublication, 'receiptId' | 'sequence'>
  ): PreparedControlEventPublication;
  enqueue(publication: PreparedControlEventPublication): boolean;
  pause(): void;
  resume(): Promise<boolean>;
  close(): void;
};

type RootKey = string | undefined;

type SquashKey = {
  entityId: string;
  root: RootKey;
  nativeRuntimeId: string | undefined;
};

type Lane = {
  root: RootKey;
  entries: PreparedControlEventPublication[];
  pending?: Promise<void>;
  pendingEntry?: PreparedControlEventPublication;
  wakeup?: ReturnType<typeof setTimeout>;
};

type PumpCycle = {
  promise: Promise<boolean>;
  resolve: (drained: boolean) => void;
  wake: Promise<void>;
  resolveWake: () => void;
  wakeSignaled: boolean;
};

function rootFor(publication: PreparedControlEventPublication): RootKey {
  return publication.session.rootKiloSessionId ?? publication.session.kiloSessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entityIdFor(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.properties)) return undefined;
  if (payload.type === 'message.updated') {
    const info = payload.properties.info;
    return isRecord(info) && typeof info.id === 'string' ? `message/${info.id}` : undefined;
  }
  if (payload.type === 'message.part.updated') {
    const part = payload.properties.part;
    if (!isRecord(part)) return undefined;
    return typeof part.messageID === 'string' && typeof part.id === 'string'
      ? `part/${part.messageID}/${part.id}`
      : undefined;
  }
  return undefined;
}

function squashKeyFor(publication: PreparedControlEventPublication): SquashKey | undefined {
  if (publication.event !== 'session.event') return undefined;
  const entityId = entityIdFor(publication.payload);
  if (!entityId) return undefined;
  return {
    entityId,
    root: rootFor(publication),
    nativeRuntimeId: publication.session.nativeRuntimeId,
  };
}

function sameSquashKey(left: SquashKey | undefined, right: SquashKey | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.entityId === right.entityId &&
    left.root === right.root &&
    left.nativeRuntimeId === right.nativeRuntimeId
  );
}

function serializedPublicationBytes(publication: ControlEventPublication): number {
  const wire: ControlEventPublication & {
    bytes?: number;
    deadlineAt?: number;
    preparedAt?: number;
  } = { ...publication };
  delete wire.bytes;
  delete wire.deadlineAt;
  delete wire.preparedAt;
  return Buffer.byteLength(
    JSON.stringify({
      type: 'request',
      requestId: 'event_00000000-0000-4000-8000-000000000000',
      operation: 'sandbox.event.publish',
      payload: wire,
    })
  );
}

function copyPublication(
  publication: PreparedControlEventPublication
): PreparedControlEventPublication {
  const copy = { ...publication };
  if (publication.preparedAt !== undefined)
    Object.defineProperty(copy, 'preparedAt', {
      value: publication.preparedAt,
      enumerable: false,
    });
  return copy;
}

function publicationFailureReason(error: unknown): ControlEventPublicationFailureReason {
  if (isRecord(error) && typeof error.publicationReason === 'string') {
    const reason = error.publicationReason;
    if (reason === 'socket_overflow' || reason === 'disconnected' || reason === 'send_failed')
      return reason;
  }
  return 'rejected';
}

function publicationFailureDetail(error: unknown): string | undefined {
  if (error instanceof Error) return error.message.slice(0, 128);
  return undefined;
}

export function createControlEventOutbox(options: {
  publish: (
    publication: ControlEventPublication,
    deadlineAt: number,
    preparedAt?: number
  ) => Promise<void>;
  onFailure: (failure: ControlEventOutboxFailure) => void;
}): ControlEventOutbox {
  const lanes = new Map<RootKey, Lane>();
  let paused = true;
  let closed = false;
  let cycle: PumpCycle | undefined;
  let nextSequence = 0;
  let lastScheduledLane: Lane | undefined;
  let pendingCount = 0;
  let pendingBytes = 0;

  const getLane = (root: RootKey): Lane => {
    const existing = lanes.get(root);
    if (existing) return existing;
    const lane: Lane = { root, entries: [] };
    lanes.set(root, lane);
    return lane;
  };

  const clearWakeup = (lane: Lane): void => {
    if (lane.wakeup) clearTimeout(lane.wakeup);
    lane.wakeup = undefined;
  };

  const cleanupLane = (lane: Lane): void => {
    if (lane.pending || lane.entries.length > 0) return;
    clearWakeup(lane);
    if (lanes.get(lane.root) === lane) lanes.delete(lane.root);
  };

  const stats = (): ControlEventOutboxStats => ({
    pendingCount,
    pendingBytes,
  });

  const reportFailure = (
    publication: PreparedControlEventPublication,
    reason: ControlEventPublicationFailureReason,
    sent: boolean,
    attempts = 1,
    error?: unknown
  ): void => {
    try {
      options.onFailure({
        reason,
        publication,
        sent,
        queueAgeMs: Math.max(0, Date.now() - (publication.preparedAt ?? Date.now())),
        attempts,
        ...stats(),
        ...(isRecord(error) && typeof error.socketBufferedBytes === 'number'
          ? { socketBufferedBytes: error.socketBufferedBytes }
          : {}),
        ...(isRecord(error) && typeof error.requestId === 'string'
          ? { requestId: error.requestId }
          : {}),
        ...(isRecord(error) && typeof error.connectionState === 'string'
          ? { connectionState: error.connectionState }
          : {}),
        ...(isRecord(error) && typeof error.connectionId === 'string'
          ? { connectionId: error.connectionId }
          : {}),
        preparedAt: publication.preparedAt,
        ...(publicationFailureDetail(error) ? { detail: publicationFailureDetail(error) } : {}),
      });
    } catch {
      return;
    }
  };

  const squashTarget = (
    lane: Lane,
    publication: PreparedControlEventPublication
  ): PreparedControlEventPublication | undefined => {
    const previous = lane.entries.at(-1);
    if (!previous || previous === lane.pendingEntry) return undefined;
    return sameSquashKey(squashKeyFor(previous), squashKeyFor(publication)) ? previous : undefined;
  };

  const hasSpaceFor = (
    lane: Lane,
    publication: PreparedControlEventPublication,
    replacement = squashTarget(lane, publication)
  ): boolean => {
    const count = pendingCount - (replacement ? 1 : 0);
    const bytes = pendingBytes - (replacement?.bytes ?? 0);
    const publicationBytes = replacement
      ? serializedPublicationBytes({ ...replacement, payload: publication.payload })
      : publication.bytes;
    return (
      count < MAX_CONTROL_EVENT_OUTBOX_EVENTS &&
      bytes + publicationBytes <= MAX_CONTROL_EVENT_OUTBOX_BYTES
    );
  };

  const removeHead = (lane: Lane, entry: PreparedControlEventPublication): boolean => {
    if (lane.entries[0] !== entry) return false;
    lane.entries.shift();
    pendingCount = Math.max(0, pendingCount - 1);
    pendingBytes = Math.max(0, pendingBytes - entry.bytes);
    scheduleWakeup(lane);
    cleanupLane(lane);
    return true;
  };

  const expireHead = (lane: Lane): void => {
    if (lane.pending) return;
    while (lane.entries[0] && Date.now() >= lane.entries[0].deadlineAt) {
      const entry = lane.entries[0];
      if (!entry || !removeHead(lane, entry)) return;
      reportFailure(entry, 'expired', false, 0);
    }
    scheduleWakeup(lane);
  };

  const scheduleWakeup = (lane: Lane): void => {
    clearWakeup(lane);
    const entry = lane.entries[0];
    if (closed || lane.pending || !entry) {
      cleanupLane(lane);
      return;
    }
    lane.wakeup = setTimeout(
      () => {
        lane.wakeup = undefined;
        expireHead(lane);
        if (!paused) void pump();
        else scheduleWakeup(lane);
      },
      Math.max(1, entry.deadlineAt - Date.now())
    );
    lane.wakeup.unref();
  };

  const prepare = (
    input: Omit<ControlEventPublication, 'receiptId' | 'sequence'>
  ): PreparedControlEventPublication => {
    const snapshot = JSON.parse(
      canonicalControlEventJson({
        ...input,
        session: sessionEventIdentitySchema.parse(input.session),
      })
    ) as Omit<ControlEventPublication, 'receiptId' | 'sequence'>;
    const sequence = nextSequence + 1;
    const receiptId = crypto.randomUUID();
    const preparedAt = Date.now();
    nextSequence = sequence;
    const publication = { ...snapshot, sequence, receiptId };
    const bytes = serializedPublicationBytes(publication);
    if (bytes > MAX_SANDBOX_CONTROL_FRAME_BYTES)
      throw new Error('Control event exceeds the frame budget');
    const prepared = {
      ...publication,
      bytes,
      preparedAt,
      deadlineAt: preparedAt + PUBLICATION_DEADLINE_MS,
    };
    Object.defineProperty(prepared, 'preparedAt', { value: preparedAt, enumerable: false });
    return prepared;
  };

  const nextRunnableLane = (): Lane | undefined => {
    if (lanes.size === 0) return undefined;
    const available = [...lanes.values()];
    const previousIndex = available.findIndex(lane => lane === lastScheduledLane);
    const start = previousIndex === -1 ? 0 : (previousIndex + 1) % available.length;
    for (let offset = 0; offset < available.length; offset += 1) {
      const lane = available[(start + offset) % available.length];
      if (!lane || lane.pending || !lane.entries[0]) continue;
      expireHead(lane);
      const entry = lane.entries[0];
      if (!entry || lane.pending || Date.now() >= entry.deadlineAt) continue;
      lastScheduledLane = lane;
      return lane;
    }
    return undefined;
  };

  const queuedEntries = (): boolean => [...lanes.values()].some(lane => lane.entries.length > 0);

  const signalCycle = (active: PumpCycle | undefined = cycle): void => {
    if (!active || active.wakeSignaled) return;
    active.wakeSignaled = true;
    active.resolveWake();
  };

  const resetCycleWake = (active: PumpCycle): void => {
    if (!active.wakeSignaled) return;
    const wake = Promise.withResolvers<void>();
    active.wake = wake.promise;
    active.resolveWake = wake.resolve;
    active.wakeSignaled = false;
  };

  const runAttempt = async (lane: Lane, entry: PreparedControlEventPublication): Promise<void> => {
    if (closed || paused || lane.entries[0] !== entry) return;
    if (Date.now() >= entry.deadlineAt) {
      if (removeHead(lane, entry)) reportFailure(entry, 'expired', false, 0);
      return;
    }
    const expired = Promise.withResolvers<void>();
    const timeout = setTimeout(expired.resolve, Math.max(1, entry.deadlineAt - Date.now()));
    timeout.unref();
    let published: Promise<void>;
    try {
      published = Promise.resolve(
        options.publish(
          {
            event: entry.event,
            receiptId: entry.receiptId,
            sequence: entry.sequence,
            session: entry.session,
            payload: entry.payload,
          },
          entry.deadlineAt,
          entry.preparedAt
        )
      );
    } catch (error) {
      published = Promise.reject(error);
    }
    try {
      const result = await Promise.race([
        published.then(
          () => 'published' as const,
          (error: unknown) => ({ error })
        ),
        expired.promise.then(() => 'expired' as const),
      ]);
      if (result === 'expired') {
        void published.catch(() => undefined);
        if (removeHead(lane, entry)) reportFailure(entry, 'expired', false, 0);
        return;
      }
      if (result === 'published') {
        removeHead(lane, entry);
        return;
      }
      if (removeHead(lane, entry))
        reportFailure(entry, publicationFailureReason(result.error), false, 1, result.error);
    } finally {
      clearTimeout(timeout);
    }
  };

  const startAttempt = (lane: Lane): void => {
    const entry = lane.entries[0];
    if (!entry || lane.pending) return;
    const pending = Promise.resolve()
      .then(() => runAttempt(lane, entry))
      .catch(error => {
        if (closed || !removeHead(lane, entry)) return;
        reportFailure(entry, publicationFailureReason(error), false, 1, error);
      })
      .then(() => {
        if (lane.pending === pending) {
          lane.pending = undefined;
          lane.pendingEntry = undefined;
        }
        scheduleWakeup(lane);
        cleanupLane(lane);
        signalCycle();
      });
    lane.pendingEntry = entry;
    lane.pending = pending;
  };

  const runCycle = async (active: PumpCycle): Promise<void> => {
    try {
      while (true) {
        for (const lane of lanes.values()) expireHead(lane);
        if (closed) {
          active.resolve(false);
          return;
        }
        if (paused) {
          active.resolve(!queuedEntries());
          return;
        }
        const lane = nextRunnableLane();
        if (lane) {
          startAttempt(lane);
          continue;
        }
        if ([...lanes.values()].some(item => item.pending !== undefined)) {
          const wake = active.wake;
          await wake;
          if (active.wake === wake) resetCycleWake(active);
          continue;
        }
        active.resolve(!queuedEntries());
        return;
      }
    } finally {
      if (cycle === active) cycle = undefined;
      for (const lane of lanes.values()) scheduleWakeup(lane);
    }
  };

  const pump = (): Promise<boolean> => {
    if (cycle) {
      signalCycle(cycle);
      return cycle.promise;
    }
    if (closed) return Promise.resolve(false);
    const next = Promise.withResolvers<boolean>();
    const wake = Promise.withResolvers<void>();
    const active: PumpCycle = {
      promise: next.promise,
      resolve: next.resolve,
      wake: wake.promise,
      resolveWake: wake.resolve,
      wakeSignaled: false,
    };
    cycle = active;
    void runCycle(active);
    return active.promise;
  };

  return {
    prepare,
    enqueue(publication) {
      const lane = getLane(rootFor(publication));
      if (closed) {
        reportFailure(publication, 'disconnected', false, 0);
        return false;
      }
      if (Date.now() >= publication.deadlineAt) {
        reportFailure(publication, 'expired', false, 0);
        cleanupLane(lane);
        return false;
      }
      const replacement = squashTarget(lane, publication);
      if (!hasSpaceFor(lane, publication, replacement)) {
        reportFailure(publication, 'queue_overflow', false, 0);
        return false;
      }
      if (replacement) {
        const index = lane.entries.length - 1;
        const bytes = serializedPublicationBytes({ ...replacement, payload: publication.payload });
        pendingBytes += bytes - replacement.bytes;
        const replaced = { ...replacement, payload: publication.payload, bytes };
        if (replacement.preparedAt !== undefined)
          Object.defineProperty(replaced, 'preparedAt', {
            value: replacement.preparedAt,
            enumerable: false,
          });
        lane.entries[index] = replaced;
      } else {
        lane.entries.push(copyPublication(publication));
        pendingCount++;
        pendingBytes += publication.bytes;
      }
      if (!paused) void pump();
      else scheduleWakeup(lane);
      return true;
    },
    pause() {
      paused = true;
      for (const lane of lanes.values()) scheduleWakeup(lane);
      signalCycle();
    },
    resume() {
      paused = false;
      return pump();
    },
    close() {
      if (closed) return;
      closed = true;
      signalCycle();
      for (const lane of lanes.values()) {
        clearWakeup(lane);
        for (const entry of lane.entries) reportFailure(entry, 'disconnected', false, 0);
        lane.entries.length = 0;
        lane.pendingEntry = undefined;
        cleanupLane(lane);
      }
      pendingCount = 0;
      pendingBytes = 0;
    },
  };
}
