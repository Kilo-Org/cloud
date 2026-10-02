import type {
  ControlPlaneEventsNotification,
  ControlPlaneOutcome,
  ControlPlaneRouteUpdate,
} from '../../shared/control-plane-protocol.js';

export const SANDBOX_NOTIFICATION_LIMITS = {
  count: 1_000,
  bytes: 8 * 1024 * 1024,
  activeLanes: 4,
} as const;

export type SandboxNotification =
  | { kind: 'events'; payload: ControlPlaneEventsNotification }
  | { kind: 'route'; payload: ControlPlaneRouteUpdate }
  | { kind: 'outcome'; payload: ControlPlaneOutcome };

type DropCause = 'capacity' | 'expired' | 'failed' | 'retired' | 'wrapper';
export type NotificationLoss = {
  cause: DropCause;
  droppedCount: number;
  droppedBytes: number;
  maxQueueAgeMs: number;
  sessionId?: string;
};
type Entry = {
  sessionId: string;
  notification: SandboxNotification;
  bytes: number;
  count: number;
  enqueuedAt: number;
  deadlineAt: number;
};

export function createSandboxNotificationDispatcher(options: {
  budgetMs: () => number;
  send: (
    sessionId: string,
    notification: SandboxNotification,
    deadlineAt: number,
    signal: AbortSignal
  ) => Promise<void>;
  waitUntil: (work: Promise<void>) => void;
  diagnostic: (loss: NotificationLoss) => void;
}) {
  const pending: Entry[] = [];
  const ready: string[] = [];
  const active = new Map<string, { entry: Entry; controller: AbortController }>();
  const losses = new Map<DropCause, NotificationLoss>();
  let bytes = 0;
  let pumpScheduled = false;
  let reportAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finishTimer: (() => void) | undefined;
  const size = (sessionId: string, notification: SandboxNotification) =>
    new TextEncoder().encode(JSON.stringify({ sessionId, ...notification })).byteLength;
  const add = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);

  function recordLoss(
    cause: DropCause,
    count: number,
    droppedBytes: number,
    age: number,
    sessionId?: string
  ) {
    const previous = losses.get(cause);
    losses.set(cause, {
      cause,
      droppedCount: add(previous?.droppedCount ?? 0, count),
      droppedBytes: add(previous?.droppedBytes ?? 0, droppedBytes),
      maxQueueAgeMs: Math.max(previous?.maxQueueAgeMs ?? 0, age),
      ...(sessionId !== undefined && /^workspace_[a-f0-9-]{36}$/.test(sessionId)
        ? { sessionId }
        : {}),
    });
    reportAt ??= Date.now() + options.budgetMs();
    arm();
  }

  function remove(index: number): Entry {
    const [entry] = pending.splice(index, 1);
    if (entry === undefined) throw new Error('Missing pending notification');
    bytes -= entry.bytes;
    if (!pending.some(item => item.sessionId === entry.sessionId)) {
      const lane = ready.indexOf(entry.sessionId);
      if (lane >= 0) ready.splice(lane, 1);
    }
    return entry;
  }

  function drop(index: number, cause: DropCause) {
    const entry = remove(index);
    recordLoss(
      cause,
      entry.count,
      entry.bytes,
      Math.max(0, Date.now() - entry.enqueuedAt),
      entry.sessionId
    );
  }

  function expire() {
    for (let index = pending.length - 1; index >= 0; index--) {
      const entry = pending[index];
      if (entry !== undefined && entry.deadlineAt <= Date.now()) drop(index, 'expired');
    }
  }

  function arm() {
    if (timer !== undefined || (pending.length === 0 && losses.size === 0)) return;
    const deadline = Math.min(reportAt ?? Infinity, ...pending.map(entry => entry.deadlineAt));
    const work = new Promise<void>(resolve => {
      finishTimer = resolve;
      timer = setTimeout(
        () => {
          timer = undefined;
          finishTimer = undefined;
          expire();
          if (reportAt !== undefined && reportAt <= Date.now()) {
            for (const loss of losses.values()) options.diagnostic(loss);
            losses.clear();
            reportAt = undefined;
          }
          schedulePump();
          resolve();
        },
        Math.max(0, deadline - Date.now())
      );
    });
    options.waitUntil(work);
  }

  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    options.waitUntil(
      Promise.resolve().then(() => {
        pumpScheduled = false;
        expire();
        while (active.size < SANDBOX_NOTIFICATION_LIMITS.activeLanes) {
          const laneIndex = ready.findIndex(sessionId => !active.has(sessionId));
          if (laneIndex < 0) break;
          const sessionId = ready[laneIndex];
          if (sessionId === undefined) break;
          ready.splice(laneIndex, 1);
          const index = pending.findIndex(entry => entry.sessionId === sessionId);
          const entry = remove(index);
          if (pending.some(item => item.sessionId === sessionId)) ready.push(sessionId);
          bytes += entry.bytes;
          const controller = new AbortController();
          active.set(sessionId, { entry, controller });
          options.waitUntil(
            (async () => {
              try {
                await options.send(
                  sessionId,
                  entry.notification,
                  entry.deadlineAt,
                  controller.signal
                );
              } catch {
                if (!controller.signal.aborted) {
                  recordLoss(
                    Date.now() >= entry.deadlineAt ? 'expired' : 'failed',
                    entry.count,
                    entry.bytes,
                    Date.now() - entry.enqueuedAt,
                    sessionId
                  );
                }
              } finally {
                bytes -= entry.bytes;
                active.delete(sessionId);
                schedulePump();
              }
            })()
          );
        }
        if (pending.length === 0 && losses.size === 0 && timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
          finishTimer?.();
          finishTimer = undefined;
        }
        arm();
      })
    );
  }

  return {
    enqueue(sessionId: string, notification: SandboxNotification) {
      expire();
      const now = Date.now();
      const entry: Entry = {
        sessionId,
        notification,
        bytes: size(sessionId, notification),
        count: 1,
        enqueuedAt: now,
        deadlineAt: now + options.budgetMs(),
      };
      if (entry.bytes > SANDBOX_NOTIFICATION_LIMITS.bytes) {
        recordLoss('capacity', 1, entry.bytes, 0, sessionId);
        return;
      }
      const adjacent = pending.findLast(item => item.sessionId === sessionId);
      const combinedBytes =
        adjacent === undefined
          ? 0
          : adjacent.bytes +
            entry.bytes -
            size(sessionId, { kind: 'events', payload: { events: [] } }) +
            1;
      if (
        adjacent?.notification.kind === 'events' &&
        notification.kind === 'events' &&
        bytes - adjacent.bytes + combinedBytes <= SANDBOX_NOTIFICATION_LIMITS.bytes
      ) {
        bytes += combinedBytes - adjacent.bytes;
        adjacent.bytes = combinedBytes;
        for (const event of notification.payload.events)
          adjacent.notification.payload.events.push(event);
        adjacent.count = add(adjacent.count, 1);
      } else {
        while (
          pending.length + active.size >= SANDBOX_NOTIFICATION_LIMITS.count ||
          bytes + entry.bytes > SANDBOX_NOTIFICATION_LIMITS.bytes
        ) {
          const index = pending.findIndex(item => item.notification.kind === 'events');
          if (index < 0) {
            recordLoss('capacity', 1, entry.bytes, 0, sessionId);
            return;
          }
          drop(index, 'capacity');
        }
        if (!pending.some(item => item.sessionId === sessionId)) ready.push(sessionId);
        if (notification.kind === 'events') {
          entry.notification = {
            kind: 'events',
            payload: { events: notification.payload.events.slice() },
          };
        }
        pending.push(entry);
        bytes += entry.bytes;
      }
      schedulePump();
      arm();
    },
    retire(sessionId: string) {
      for (let index = pending.length - 1; index >= 0; index--) {
        if (pending[index]?.sessionId === sessionId) drop(index, 'retired');
      }
      const running = active.get(sessionId);
      if (running !== undefined && !running.controller.signal.aborted) {
        running.controller.abort();
        recordLoss(
          'retired',
          running.entry.count,
          running.entry.bytes,
          Date.now() - running.entry.enqueuedAt,
          sessionId
        );
      }
      schedulePump();
    },
    wrapperDropped(count: number) {
      recordLoss('wrapper', count, 0, 0);
    },
    snapshot() {
      return {
        pending: pending.length,
        retained: pending.length + active.size,
        bytes,
        active: active.size,
        lanes: ready.length,
        oldestAgeMs: Math.max(0, ...pending.map(entry => Date.now() - entry.enqueuedAt)),
        losses: [...losses.values()].map(loss => ({ ...loss })),
      };
    },
  };
}
