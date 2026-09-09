import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  SANDBOX_CONTROL_OPERATION_LIMIT,
} from '../shared/sandbox-control-protocol.js';

const MAX_SESSION_FORWARD_BYTES = 4 * MAX_SANDBOX_CONTROL_FRAME_BYTES;

export class SessionForwardingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'SessionForwardingError';
  }
}

export type SessionForwardingStats = {
  waiting: number;
  inFlight: number;
  bufferedBytes: number;
  highWater: number;
};

export type FencedSessionForward<T> = {
  sessionId: string;
  bytes: number;
  deadlineAt: number;
  fence: () => Promise<boolean>;
  forward: () => Promise<T>;
};

export type SessionForwarding = {
  enqueue: <T>(sessionId: string, forward: () => Promise<T>) => Promise<T>;
  enqueueFenced: <T>(input: FencedSessionForward<T>) => Promise<T>;
  stats: () => SessionForwardingStats;
  get: (sessionId: string) => Promise<void> | undefined;
  values: () => IterableIterator<Promise<void>>;
  delete: (sessionId: string) => void;
};

export function createSessionForwarding(): SessionForwarding {
  const chains = new Map<string, Promise<void>>();
  const stats: SessionForwardingStats = {
    waiting: 0,
    inFlight: 0,
    bufferedBytes: 0,
    highWater: 0,
  };

  const enqueue = <T>(sessionId: string, forward: () => Promise<T>): Promise<T> => {
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(forward);
    chains.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  };

  return {
    enqueue,
    enqueueFenced<T>(input: FencedSessionForward<T>): Promise<T> {
      if (input.bytes > MAX_SANDBOX_CONTROL_FRAME_BYTES)
        return Promise.reject(new SessionForwardingError('Forwarded frame is too large', false));
      if (
        stats.waiting + stats.inFlight >= SANDBOX_CONTROL_OPERATION_LIMIT ||
        stats.bufferedBytes + input.bytes > MAX_SESSION_FORWARD_BYTES
      )
        return Promise.reject(
          new SessionForwardingError('Forwarding capacity is unavailable', true)
        );
      stats.waiting++;
      stats.bufferedBytes += input.bytes;
      stats.highWater = Math.max(stats.highWater, stats.waiting + stats.inFlight);
      return enqueue(input.sessionId, async () => {
        stats.waiting--;
        stats.inFlight++;
        try {
          if (
            Date.now() >= input.deadlineAt ||
            !(await input.fence()) ||
            Date.now() >= input.deadlineAt
          )
            throw new SessionForwardingError('Forwarding fence changed', false);
          const result = await input.forward();
          if (
            Date.now() >= input.deadlineAt ||
            !(await input.fence()) ||
            Date.now() >= input.deadlineAt
          )
            throw new SessionForwardingError('Forwarding fence changed', false);
          return result;
        } finally {
          stats.inFlight--;
          stats.bufferedBytes -= input.bytes;
        }
      });
    },
    stats: () => ({ ...stats }),
    get: sessionId => chains.get(sessionId),
    values: () => chains.values(),
    delete: sessionId => chains.delete(sessionId),
  };
}
