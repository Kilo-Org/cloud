import { canonicalControlEventJson } from '../../../src/shared/control-event-canonical.js';
import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  SANDBOX_EVENT_BATCH_MAX_ITEMS,
  sameSessionEventIdentity,
  sessionEventIdentitySchema,
} from '../../../src/shared/sandbox-control-protocol.js';
import type { SessionEventIdentity } from '../../../src/shared/sandbox-control-protocol.js';

export const MAX_CONTROL_EVENT_OUTBOX_EVENTS = 2048;
export const MAX_CONTROL_EVENT_OUTBOX_BYTES = 4 * MAX_SANDBOX_CONTROL_FRAME_BYTES;
const PUBLICATION_DEADLINE_MS = 60_000;
export const CONTROL_EVENT_BATCH_WINDOW_MS = 25;

const URGENT_EVENT_TYPES = new Set([
  'question.asked',
  'question.replied',
  'question.rejected',
  'permission.asked',
  'permission.replied',
  'session.idle',
  'session.error',
  'session.turn.close',
  'session.message.outcome',
]);

const BATCH_FRAME_ENVELOPE_BYTES = Buffer.byteLength(
  JSON.stringify({
    type: 'request',
    requestId: 'event_00000000-0000-4000-8000-000000000000',
    operation: 'sandbox.event.publishBatch',
    payload: { items: [] },
  })
);

export type ControlEventPublication = {
  event: 'session.event' | 'session.preparing';
  receiptId: string;
  sequence: number;
  session: SessionEventIdentity;
  payload: unknown;
};

export type BatchControlEventPublication = ControlEventPublication & { preparedAt?: number };

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
  identity: SessionEventIdentity;
};

type TailReplacement = {
  previous: PreparedControlEventPublication;
  payload: unknown;
  bytes: number;
  deadlineAt: number;
};

type BatchSelection = {
  items: PreparedControlEventPublication[];
  byteFull: boolean;
  urgentBoundary: boolean;
};

type Lane = {
  root: RootKey;
  entries: PreparedControlEventPublication[];
  pending?: Promise<void>;
  pendingEntry?: PreparedControlEventPublication;
  pendingBatch?: PreparedControlEventPublication[];
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

function isUrgentPublication(publication: PreparedControlEventPublication): boolean {
  if (publication.event !== 'session.event') return false;
  if (!isRecord(publication.payload) || typeof publication.payload.type !== 'string') return false;
  return URGENT_EVENT_TYPES.has(publication.payload.type);
}

export function controlEventPublicationWireItem(
  publication: ControlEventPublication
): ControlEventPublication {
  return {
    event: publication.event,
    receiptId: publication.receiptId,
    sequence: publication.sequence,
    session: publication.session,
    payload: publication.payload,
  };
}

function publicationWireBytes(publication: PreparedControlEventPublication): number {
  return Buffer.byteLength(JSON.stringify(controlEventPublicationWireItem(publication)));
}

function squashKeyFor(publication: PreparedControlEventPublication): SquashKey | undefined {
  if (publication.event !== 'session.event') return undefined;
  const entityId = entityIdFor(publication.payload);
  if (!entityId) return undefined;
  return { entityId, identity: publication.session };
}

function sameSquashKey(left: SquashKey | undefined, right: SquashKey | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.entityId === right.entityId &&
    sameSessionEventIdentity(left.identity, right.identity)
  );
}

type DeltaEnvelopeParts = {
  left: Record<string, unknown>;
  leftProperties: Record<string, unknown>;
  leftDelta: string;
  rightDelta: string;
};

function deltaEnvelopeParts(left: unknown, right: unknown): DeltaEnvelopeParts | undefined {
  if (!isRecord(left) || !isRecord(right)) return undefined;
  if (left.type !== 'message.part.delta' || right.type !== 'message.part.delta') return undefined;
  const leftProperties = left.properties;
  const rightProperties = right.properties;
  if (!isRecord(leftProperties) || !isRecord(rightProperties)) return undefined;
  if (leftProperties.field !== 'text' || rightProperties.field !== 'text') return undefined;
  for (const key of ['sessionID', 'messageID', 'partID'] as const) {
    const value = leftProperties[key];
    if (typeof value !== 'string' || value !== rightProperties[key]) return undefined;
  }
  const leftDelta = leftProperties.delta;
  const rightDelta = rightProperties.delta;
  if (typeof leftDelta !== 'string' || typeof rightDelta !== 'string') return undefined;
  const keys = Object.keys(leftProperties);
  if (keys.length !== Object.keys(rightProperties).length) return undefined;
  for (const key of keys) {
    if (!Object.hasOwn(rightProperties, key)) return undefined;
    if (key !== 'delta' && !Object.is(leftProperties[key], rightProperties[key])) return undefined;
  }
  return { left, leftProperties, leftDelta, rightDelta };
}

function mergedDeltaPayload(parts: DeltaEnvelopeParts): unknown {
  return {
    ...parts.left,
    properties: {
      ...parts.leftProperties,
      delta: `${parts.leftDelta}${parts.rightDelta}`,
    },
  };
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
  publishBatch?: (
    publications: BatchControlEventPublication[],
    deadlineAt: number
  ) => Promise<void>;
  supportsBatches?: () => boolean;
  onFailure: (failure: ControlEventOutboxFailure) => void;
}): ControlEventOutbox {
  const supportsBatches = options.supportsBatches ?? (() => false);
  const publishBatch = options.publishBatch ?? (() => Promise.resolve());
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

  const tailCandidate = (lane: Lane): PreparedControlEventPublication | undefined => {
    const previous = lane.entries.at(-1);
    if (!previous || previous === lane.pendingEntry) return undefined;
    if (lane.pendingBatch?.includes(previous)) return undefined;
    return previous;
  };

  const squashTarget = (
    lane: Lane,
    publication: PreparedControlEventPublication
  ): TailReplacement | undefined => {
    const previous = tailCandidate(lane);
    if (!previous) return undefined;
    if (!sameSquashKey(squashKeyFor(previous), squashKeyFor(publication))) return undefined;
    return {
      previous,
      payload: publication.payload,
      bytes: serializedPublicationBytes({ ...previous, payload: publication.payload }),
      deadlineAt: previous.deadlineAt,
    };
  };

  // Retaining the older deadline would expire a still-growing group and lose its fresh text.
  const deltaMergeTarget = (
    lane: Lane,
    publication: PreparedControlEventPublication
  ): TailReplacement | undefined => {
    const previous = tailCandidate(lane);
    if (!previous) return undefined;
    if (previous.event !== 'session.event' || publication.event !== 'session.event')
      return undefined;
    if (!sameSessionEventIdentity(previous.session, publication.session)) return undefined;
    const parts = deltaEnvelopeParts(previous.payload, publication.payload);
    if (!parts) return undefined;
    const payload = mergedDeltaPayload(parts);
    const bytes = serializedPublicationBytes({ ...previous, payload });
    // Declining is not unconditionally lossless: the fallback append can still drop the
    // delta as queue_overflow when the lane is already at its entry cap.
    if (bytes > MAX_SANDBOX_CONTROL_FRAME_BYTES) return undefined;
    return { previous, payload, bytes, deadlineAt: publication.deadlineAt };
  };

  const hasSpaceFor = (
    publication: PreparedControlEventPublication,
    replacement: TailReplacement | undefined
  ): boolean => {
    const count = pendingCount - (replacement ? 1 : 0);
    const bytes = pendingBytes - (replacement?.previous.bytes ?? 0);
    const publicationBytes = replacement ? replacement.bytes : publication.bytes;
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

  const selectBatch = (lane: Lane): BatchSelection => {
    const head = lane.entries[0];
    if (!head) return { items: [], byteFull: false, urgentBoundary: false };
    const items: PreparedControlEventPublication[] = [];
    let addedBytes = 0;
    let byteFull = false;
    let urgentBoundary = false;
    for (const entry of lane.entries) {
      if (items.length > 0 && !sameSessionEventIdentity(entry.session, head.session)) {
        urgentBoundary = isUrgentPublication(entry);
        break;
      }
      if (items.length >= SANDBOX_EVENT_BATCH_MAX_ITEMS) break;
      const entryBytes = publicationWireBytes(entry);
      if (
        BATCH_FRAME_ENVELOPE_BYTES + addedBytes + entryBytes + 1 >
        MAX_SANDBOX_CONTROL_FRAME_BYTES
      ) {
        byteFull = true;
        break;
      }
      items.push(entry);
      addedBytes += entryBytes + 1;
      if (isUrgentPublication(entry)) break;
    }
    return { items, byteFull, urgentBoundary };
  };

  const batchSelectionReady = (selection: BatchSelection): boolean => {
    const { items, byteFull } = selection;
    const head = items[0];
    if (!head) return true;
    if (items.length >= SANDBOX_EVENT_BATCH_MAX_ITEMS) return true;
    if (byteFull) return true;
    if (selection.urgentBoundary) return true;
    const last = items[items.length - 1];
    if (last && isUrgentPublication(last)) return true;
    return Date.now() >= (head.preparedAt ?? Date.now()) + CONTROL_EVENT_BATCH_WINDOW_MS;
  };

  type LaneSchedule =
    | { kind: 'runnable'; selection: BatchSelection }
    | { kind: 'wait'; at: number };

  const scheduleLane = (lane: Lane): LaneSchedule => {
    if (!supportsBatches())
      return { kind: 'runnable', selection: { items: [], byteFull: false, urgentBoundary: false } };
    const selection = selectBatch(lane);
    if (batchSelectionReady(selection)) return { kind: 'runnable', selection };
    const head = selection.items[0];
    return {
      kind: 'wait',
      at: (head?.preparedAt ?? Date.now()) + CONTROL_EVENT_BATCH_WINDOW_MS,
    };
  };

  const nextSchedule = (): { lane?: Lane; selection?: BatchSelection; waitAt?: number } => {
    if (lanes.size === 0) return {};
    const available = [...lanes.values()];
    const previousIndex = available.findIndex(lane => lane === lastScheduledLane);
    const start = previousIndex === -1 ? 0 : (previousIndex + 1) % available.length;
    let waitAt: number | undefined;
    for (let offset = 0; offset < available.length; offset += 1) {
      const lane = available[(start + offset) % available.length];
      if (!lane || lane.pending) continue;
      expireHead(lane);
      const entry = lane.entries[0];
      if (!entry || lane.pending || Date.now() >= entry.deadlineAt) continue;
      const schedule = scheduleLane(lane);
      if (schedule.kind === 'runnable') {
        lastScheduledLane = lane;
        return { lane, selection: schedule.selection };
      }
      waitAt = waitAt === undefined ? schedule.at : Math.min(waitAt, schedule.at);
    }
    return { waitAt };
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

  const pauseOutbox = (): void => {
    paused = true;
    for (const lane of lanes.values()) scheduleWakeup(lane);
    signalCycle();
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
      if (Date.now() >= entry.deadlineAt) {
        if (removeHead(lane, entry)) reportFailure(entry, 'expired', false, 0);
        return;
      }
      const reason = publicationFailureReason(result.error);
      if (reason === 'disconnected') {
        pauseOutbox();
        return;
      }
      if (removeHead(lane, entry)) reportFailure(entry, reason, false, 1, result.error);
    } finally {
      clearTimeout(timeout);
    }
  };

  const runBatchAttempt = async (
    lane: Lane,
    batch: PreparedControlEventPublication[]
  ): Promise<void> => {
    if (closed || paused) return;
    const head = batch[0];
    if (!head || lane.entries[0] !== head) return;
    if (Date.now() >= head.deadlineAt) {
      if (removeHead(lane, head)) reportFailure(head, 'expired', false, 0);
      return;
    }
    let published: Promise<void>;
    try {
      published = Promise.resolve(
        publishBatch(
          batch.map(entry => ({
            ...controlEventPublicationWireItem(entry),
            ...(entry.preparedAt === undefined ? {} : { preparedAt: entry.preparedAt }),
          })),
          head.deadlineAt
        )
      );
    } catch (error) {
      published = Promise.reject(error);
    }
    try {
      await published;
      for (const entry of batch) removeHead(lane, entry);
    } catch (error) {
      if (Date.now() >= head.deadlineAt) {
        if (removeHead(lane, head)) reportFailure(head, 'expired', false, 0);
        return;
      }
      const reason = publicationFailureReason(error);
      if (reason === 'disconnected') {
        pauseOutbox();
        return;
      }
      for (const entry of batch) {
        if (removeHead(lane, entry)) reportFailure(entry, reason, false, 1, error);
      }
    } finally {
      lane.pendingBatch = undefined;
    }
  };

  const startAttempt = (lane: Lane, selection: BatchSelection): void => {
    const entry = lane.entries[0];
    if (!entry || lane.pending) return;
    const batch = selection.items;
    const useBatch = batch.length > 0;
    const pending = Promise.resolve()
      .then(() => (useBatch ? runBatchAttempt(lane, batch) : runAttempt(lane, entry)))
      .catch(error => {
        if (closed) return;
        if (useBatch && lane.pendingBatch) {
          const reason = publicationFailureReason(error);
          for (const item of lane.pendingBatch) {
            if (removeHead(lane, item)) reportFailure(item, reason, false, 1, error);
          }
          lane.pendingBatch = undefined;
          return;
        }
        if (!removeHead(lane, entry)) return;
        reportFailure(entry, publicationFailureReason(error), false, 1, error);
      })
      .then(() => {
        if (lane.pending === pending) {
          lane.pending = undefined;
          lane.pendingEntry = undefined;
          lane.pendingBatch = undefined;
        }
        scheduleWakeup(lane);
        cleanupLane(lane);
        signalCycle();
      });
    lane.pendingEntry = entry;
    lane.pendingBatch = useBatch ? batch : undefined;
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
        const scheduled = nextSchedule();
        if (scheduled.lane && scheduled.selection) {
          startAttempt(scheduled.lane, scheduled.selection);
          continue;
        }
        if ([...lanes.values()].some(item => item.pending !== undefined)) {
          const wake = active.wake;
          await wake;
          if (active.wake === wake) resetCycleWake(active);
          continue;
        }
        if (scheduled.waitAt !== undefined) {
          if (scheduled.waitAt <= Date.now()) continue;
          const wake = active.wake;
          const timer = Promise.withResolvers<void>();
          const handle = setTimeout(timer.resolve, Math.max(1, scheduled.waitAt - Date.now()));
          handle.unref();
          try {
            await Promise.race([timer.promise, wake]);
          } finally {
            clearTimeout(handle);
          }
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
      const replacement = squashTarget(lane, publication) ?? deltaMergeTarget(lane, publication);
      if (!hasSpaceFor(publication, replacement)) {
        reportFailure(publication, 'queue_overflow', false, 0);
        return false;
      }
      if (replacement) {
        const index = lane.entries.length - 1;
        pendingBytes += replacement.bytes - replacement.previous.bytes;
        const replaced = {
          ...replacement.previous,
          payload: replacement.payload,
          bytes: replacement.bytes,
          deadlineAt: replacement.deadlineAt,
        };
        if (replacement.previous.preparedAt !== undefined)
          Object.defineProperty(replaced, 'preparedAt', {
            value: replacement.previous.preparedAt,
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
      pauseOutbox();
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
        lane.pendingBatch = undefined;
        cleanupLane(lane);
      }
      pendingCount = 0;
      pendingBytes = 0;
    },
  };
}
