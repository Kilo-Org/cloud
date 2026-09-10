import { canonicalControlEventJson } from '../../../src/shared/control-event-canonical.js';
import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  sessionEventIdentitySchema,
} from '../../../src/shared/sandbox-control-protocol.js';
import type { SessionEventIdentity } from '../../../src/shared/sandbox-control-protocol.js';

const MAX_EVENTS = 256;
const MAX_BYTES = 4 * MAX_SANDBOX_CONTROL_FRAME_BYTES;
const RETRY_DELAY_MS = 250;

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
};

export type ControlEventOutboxFailure = {
  reason: 'expired' | 'rejected';
  publication: ControlEventPublication;
};

export type ControlEventOutbox = {
  prepare(
    input: Omit<ControlEventPublication, 'receiptId' | 'sequence'>
  ): PreparedControlEventPublication;
  enqueue(publication: PreparedControlEventPublication): boolean;
  waitForSpace(publication: PreparedControlEventPublication): Promise<boolean>;
  pause(): void;
  resume(): Promise<boolean>;
  close(): void;
};

type RootKey = string | undefined;

type SpaceWaiter = {
  promise: Promise<boolean>;
  ready: boolean;
  resolve: (available: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type Lane = {
  root: RootKey;
  entries: PreparedControlEventPublication[];
  spaceWaiters: Map<PreparedControlEventPublication, SpaceWaiter>;
  waitingBytes: number;
  bytes: number;
  pending?: Promise<void>;
  expirePending?: () => void;
  retryAt?: number;
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

function isRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true
  );
}

export function createControlEventOutbox(options: {
  publish: (publication: ControlEventPublication, deadlineAt: number) => Promise<void>;
  onFailure: (failure: ControlEventOutboxFailure) => void;
}): ControlEventOutbox {
  const lanes = new Map<RootKey, Lane>();
  let paused = true;
  let closed = false;
  let cycle: PumpCycle | undefined;
  let nextSequence = 0;
  let lastScheduledLane: Lane | undefined;

  const getLane = (root: RootKey): Lane => {
    const existing = lanes.get(root);
    if (existing) return existing;
    const lane: Lane = {
      root,
      entries: [],
      spaceWaiters: new Map(),
      waitingBytes: 0,
      bytes: 0,
    };
    lanes.set(root, lane);
    return lane;
  };

  const clearWakeup = (lane: Lane): void => {
    clearTimeout(lane.wakeup);
    lane.wakeup = undefined;
  };

  const cleanupLane = (lane: Lane): void => {
    if (lane.pending || lane.entries.length > 0 || lane.spaceWaiters.size > 0) return;
    clearWakeup(lane);
    if (lanes.get(lane.root) === lane) lanes.delete(lane.root);
  };

  const reportFailure = (failure: ControlEventOutboxFailure): void => {
    try {
      options.onFailure(failure);
    } catch {
      // Failure reporting must not strand the other root lanes.
    }
  };

  const hasSpaceFor = (lane: Lane, publication: PreparedControlEventPublication): boolean => {
    if (lane.entries.length >= MAX_EVENTS || lane.bytes + publication.bytes > MAX_BYTES)
      return false;
    const now = Date.now();
    for (const reserved of lane.spaceWaiters.keys()) {
      if (reserved.sequence < publication.sequence && now < reserved.deadlineAt) return false;
    }
    return true;
  };

  const releaseSpaceWaiter = (
    lane: Lane,
    publication: PreparedControlEventPublication
  ): SpaceWaiter | undefined => {
    const waiter = lane.spaceWaiters.get(publication);
    if (!waiter) return undefined;
    clearTimeout(waiter.timeout);
    lane.spaceWaiters.delete(publication);
    lane.waitingBytes -= publication.bytes;
    cleanupLane(lane);
    return waiter;
  };

  const notifySpace = (lane: Lane, available: boolean): void => {
    const now = Date.now();
    for (const [publication, waiter] of lane.spaceWaiters) {
      if (!available || now >= publication.deadlineAt) {
        const released = releaseSpaceWaiter(lane, publication);
        released?.resolve(available ? true : false);
      } else if (hasSpaceFor(lane, publication)) {
        waiter.ready = true;
        waiter.resolve(true);
      }
    }
    cleanupLane(lane);
  };

  const removeHead = (lane: Lane, entry: PreparedControlEventPublication): boolean => {
    if (lane.entries[0] !== entry) return false;
    lane.entries.shift();
    lane.bytes -= entry.bytes;
    lane.retryAt = undefined;
    notifySpace(lane, true);
    scheduleWakeup(lane);
    cleanupLane(lane);
    return true;
  };

  const expireHead = (lane: Lane): void => {
    if (lane.pending) return;
    while (lane.entries[0] && Date.now() >= lane.entries[0].deadlineAt) {
      const entry = lane.entries[0];
      if (!entry || !removeHead(lane, entry)) return;
      reportFailure({ reason: 'expired', publication: entry });
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
    const now = Date.now();
    const nextAt = paused ? entry.deadlineAt : Math.min(lane.retryAt ?? now, entry.deadlineAt);
    lane.wakeup = setTimeout(
      () => {
        lane.wakeup = undefined;
        expireHead(lane);
        if (!paused) void pump();
        else scheduleWakeup(lane);
      },
      Math.max(1, nextAt - now)
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
    nextSequence = sequence;
    const publication = { ...snapshot, sequence, receiptId };
    const bytes = Buffer.byteLength(
      JSON.stringify({
        type: 'request',
        requestId: '00000000-0000-4000-8000-000000000000',
        operation: 'sandbox.event.publish',
        payload: publication,
      })
    );
    if (bytes > MAX_SANDBOX_CONTROL_FRAME_BYTES)
      throw new Error('Control event exceeds the frame budget');
    return { ...publication, bytes, deadlineAt: Date.now() + 30_000 };
  };

  const nextRunnableLane = (): Lane | undefined => {
    if (lanes.size === 0) return undefined;
    const available = [...lanes.values()];
    const previousIndex = available.findIndex(lane => lane === lastScheduledLane);
    const start = previousIndex === -1 ? 0 : (previousIndex + 1) % available.length;
    const now = Date.now();
    for (let offset = 0; offset < available.length; offset += 1) {
      const lane = available[(start + offset) % available.length];
      if (!lane || lane.pending || !lane.entries[0]) continue;
      if (lane.retryAt !== undefined) {
        if (now < lane.retryAt) continue;
        lane.retryAt = undefined;
      }
      if (now >= lane.entries[0].deadlineAt) expireHead(lane);
      const entry = lane.entries[0];
      if (!entry || lane.pending || Date.now() >= entry.deadlineAt) continue;
      lastScheduledLane = lane;
      return lane;
    }
    return undefined;
  };

  const queuedEntries = (): boolean => {
    for (const lane of lanes.values()) if (lane.entries.length > 0) return true;
    return false;
  };

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
    const expired = Promise.withResolvers<void>();
    lane.expirePending = expired.resolve;
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
          entry.deadlineAt
        )
      );
    } catch (error) {
      published = Promise.reject(error);
    }
    try {
      try {
        await Promise.race([published, expired.promise]);
      } catch (error) {
        if (closed || Date.now() >= entry.deadlineAt) {
          void published.catch(() => undefined);
          return;
        }
        if (isRetryable(error)) {
          lane.retryAt = Date.now() + RETRY_DELAY_MS;
          return;
        }
        if (removeHead(lane, entry)) reportFailure({ reason: 'rejected', publication: entry });
        return;
      }

      if (closed || Date.now() >= entry.deadlineAt) {
        void published.catch(() => undefined);
        if (!closed && removeHead(lane, entry))
          reportFailure({ reason: 'expired', publication: entry });
        return;
      }
      removeHead(lane, entry);
    } finally {
      clearTimeout(timeout);
      if (lane.expirePending === expired.resolve) lane.expirePending = undefined;
    }
  };

  const startAttempt = (lane: Lane): void => {
    const entry = lane.entries[0];
    if (!entry || lane.pending) return;
    const pending = Promise.resolve()
      .then(() => runAttempt(lane, entry))
      .catch(() => {
        if (closed || !removeHead(lane, entry)) return;
        reportFailure({ reason: 'rejected', publication: entry });
      })
      .then(() => {
        if (lane.pending === pending) lane.pending = undefined;
        scheduleWakeup(lane);
        cleanupLane(lane);
      });
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

        const pending = [...lanes.values()]
          .map(item => item.pending)
          .filter((item): item is Promise<void> => item !== undefined);
        if (pending.length > 0) {
          const wake = active.wake;
          await Promise.race([...pending, wake]);
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
      if (closed) return false;
      const lane = getLane(rootFor(publication));
      if (Date.now() >= publication.deadlineAt) {
        releaseSpaceWaiter(lane, publication)?.resolve(true);
        notifySpace(lane, true);
        reportFailure({ reason: 'expired', publication });
        cleanupLane(lane);
        return true;
      }
      if (!hasSpaceFor(lane, publication)) return false;
      lane.entries.push({ ...publication });
      lane.bytes += publication.bytes;
      releaseSpaceWaiter(lane, publication)?.resolve(true);
      notifySpace(lane, true);
      if (!paused) void pump();
      else scheduleWakeup(lane);
      return true;
    },
    waitForSpace(publication) {
      if (closed) return Promise.resolve(false);
      const lane = getLane(rootFor(publication));
      if (Date.now() >= publication.deadlineAt) return Promise.resolve(true);
      const existing = lane.spaceWaiters.get(publication);
      if (existing) {
        if (existing.ready && !hasSpaceFor(lane, publication)) {
          const { promise, resolve } = Promise.withResolvers<boolean>();
          existing.promise = promise;
          existing.resolve = resolve;
          existing.ready = false;
        }
        return existing.promise;
      }
      if (lane.spaceWaiters.size >= MAX_EVENTS || lane.waitingBytes + publication.bytes > MAX_BYTES)
        return Promise.resolve(false);
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const timeout = setTimeout(
        () => {
          const released = releaseSpaceWaiter(lane, publication);
          released?.resolve(true);
          notifySpace(lane, true);
        },
        Math.max(1, publication.deadlineAt - Date.now())
      );
      timeout.unref();
      const ready = hasSpaceFor(lane, publication);
      lane.spaceWaiters.set(publication, { promise, resolve, timeout, ready });
      lane.waitingBytes += publication.bytes;
      if (ready) resolve(true);
      return promise;
    },
    pause() {
      paused = true;
      for (const lane of lanes.values()) scheduleWakeup(lane);
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
        lane.expirePending?.();
        lane.entries.length = 0;
        lane.bytes = 0;
        notifySpace(lane, false);
        cleanupLane(lane);
      }
    },
  };
}
