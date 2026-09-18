import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  SANDBOX_CONTROL_FORWARD_OPERATION_LIMIT,
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
  type Chain = {
    tail: Promise<void>;
    active: number;
    detached: boolean;
  };
  const chains = new Map<string, Chain>();
  const stats: SessionForwardingStats = {
    waiting: 0,
    inFlight: 0,
    bufferedBytes: 0,
    highWater: 0,
  };

  const cleanup = (sessionId: string, chain: Chain): void => {
    if (chain.active === 0 && chain.detached && chains.get(sessionId) === chain)
      chains.delete(sessionId);
  };

  const enqueue = <T>(sessionId: string, forward: () => Promise<T>): Promise<T> => {
    const chain =
      chains.get(sessionId) ??
      (() => {
        const created: Chain = { tail: Promise.resolve(), active: 0, detached: false };
        chains.set(sessionId, created);
        return created;
      })();
    chain.active++;
    const previous = chain.tail;
    const next = previous.catch(() => undefined).then(forward);
    chain.tail = next.then(
      () => {
        chain.active--;
        cleanup(sessionId, chain);
      },
      () => {
        chain.active--;
        cleanup(sessionId, chain);
      }
    );
    return next;
  };

  return {
    enqueue,
    enqueueFenced<T>(input: FencedSessionForward<T>): Promise<T> {
      if (input.bytes > MAX_SANDBOX_CONTROL_FRAME_BYTES)
        return Promise.reject(new SessionForwardingError('Forwarded frame is too large', false));
      if (
        stats.waiting + stats.inFlight >= SANDBOX_CONTROL_FORWARD_OPERATION_LIMIT ||
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
    get: sessionId => chains.get(sessionId)?.tail,
    values: function* () {
      for (const chain of chains.values()) yield chain.tail;
    },
    delete: sessionId => {
      const chain = chains.get(sessionId);
      if (!chain) return;
      chain.detached = true;
      cleanup(sessionId, chain);
    },
  };
}
