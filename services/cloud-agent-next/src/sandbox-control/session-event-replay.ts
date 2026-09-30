import { MAX_SANDBOX_CONTROL_FRAME_BYTES } from '../shared/sandbox-control-protocol.js';

// Bounded per-session replay of session frames whose forwarding fence changed or
// whose forward deadline passed. A wrapper that never returns can only fill the
// caps and then every entry expires: the queue cannot grow without limit.
export const MAX_SESSION_EVENT_REPLAY_EVENTS = 2048;
export const MAX_SESSION_EVENT_REPLAY_BYTES = 4 * MAX_SANDBOX_CONTROL_FRAME_BYTES;
export const SESSION_EVENT_REPLAY_TTL_MS = 90_000;

export type SessionEventReplayPush<T> = {
  sessionId: string;
  bytes: number;
  expiresAt: number;
  value: T;
};

export type SessionEventReplayStats = {
  events: number;
  bytes: number;
  sessions: number;
};

export type SessionEventReplayEntry<T> = {
  value: T;
  bytes: number;
  expiresAt: number;
};

export type SessionEventReplayQueue<T> = {
  push: (entry: SessionEventReplayPush<T>) => 'queued' | 'overflow';
  shift: (sessionId: string, now: number) => SessionEventReplayEntry<T> | undefined;
  restore: (sessionId: string, entry: SessionEventReplayEntry<T>) => 'queued' | 'overflow';
  has: (sessionId: string) => boolean;
  sessions: () => string[];
  expire: (now: number) => T[];
  stats: () => SessionEventReplayStats;
};

type RetainedEntry<T> = {
  bytes: number;
  expiresAt: number;
  value: T;
};

export function createSessionEventReplayQueue<T>(): SessionEventReplayQueue<T> {
  const queues = new Map<string, RetainedEntry<T>[]>();
  let events = 0;
  let bytes = 0;

  const release = (entry: RetainedEntry<T>): void => {
    events -= 1;
    bytes -= entry.bytes;
  };

  return {
    push({ sessionId, bytes: entryBytes, expiresAt, value }) {
      // Reject the newest entry on overflow so the retained prefix keeps FIFO order.
      if (
        events >= MAX_SESSION_EVENT_REPLAY_EVENTS ||
        bytes + entryBytes > MAX_SESSION_EVENT_REPLAY_BYTES
      )
        return 'overflow';
      const entry: RetainedEntry<T> = { bytes: entryBytes, expiresAt, value };
      const queue = queues.get(sessionId);
      if (queue) queue.push(entry);
      else queues.set(sessionId, [entry]);
      events += 1;
      bytes += entryBytes;
      return 'queued';
    },
    shift(sessionId, _now) {
      const queue = queues.get(sessionId);
      if (!queue) return undefined;
      const entry = queue.shift();
      if (!entry) return undefined;
      release(entry);
      if (queue.length === 0) queues.delete(sessionId);
      return { value: entry.value, bytes: entry.bytes, expiresAt: entry.expiresAt };
    },
    restore(sessionId, entry) {
      // Return an unapplied entry to the front of its session queue. It keeps its
      // original expiry, so a fence that keeps changing cannot retain it forever.
      if (
        events >= MAX_SESSION_EVENT_REPLAY_EVENTS ||
        bytes + entry.bytes > MAX_SESSION_EVENT_REPLAY_BYTES
      )
        return 'overflow';
      const restored: RetainedEntry<T> = {
        bytes: entry.bytes,
        expiresAt: entry.expiresAt,
        value: entry.value,
      };
      const queue = queues.get(sessionId);
      if (queue) queue.unshift(restored);
      else queues.set(sessionId, [restored]);
      events += 1;
      bytes += entry.bytes;
      return 'queued';
    },
    has(sessionId) {
      return queues.has(sessionId);
    },
    sessions() {
      return [...queues.keys()];
    },
    expire(now) {
      const expired: T[] = [];
      for (const [sessionId, queue] of queues) {
        const retained = queue.filter(entry => {
          if (entry.expiresAt > now) return true;
          release(entry);
          expired.push(entry.value);
          return false;
        });
        if (retained.length === 0) queues.delete(sessionId);
        else queues.set(sessionId, retained);
      }
      return expired;
    },
    stats() {
      return { events, bytes, sessions: queues.size };
    },
  };
}
